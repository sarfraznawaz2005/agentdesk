# AgentDesk MVP — Product Requirements Document

> AI-powered development platform that replaces human developers with autonomous agent teams.

> ⚠️ **STATUS: HISTORICAL MVP PLAN — superseded.** This is the original MVP PRD and
> no longer describes the shipped system. Notably, the `WorkflowEngine` state machine
> central to this document was **never built** (the PM is the sole orchestrator); the
> DB schema, agent roster, provider list, tool names, and "single v1 migration" claims
> are all out of date. For current architecture see `docs/workflow.md`.
> Kept for historical/product context only.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack](#2-tech-stack)
3. [MVP Phases](#3-mvp-phases)
4. [Phase 1 — Foundation](#4-phase-1--foundation)
5. [Phase 2 — Chat & Agent Intelligence](#5-phase-2--chat--agent-intelligence)
6. [Phase 3 — Kanban & Autonomous Workflow](#6-phase-3--kanban--autonomous-workflow)
7. [Phase 4 — Plugin System & Integrations](#7-phase-4--plugin-system--integrations)
8. [Phase 5 — Polish & Production Readiness](#8-phase-5--polish--production-readiness)
9. [Database Schema Overview](#9-database-schema-overview)
10. [Agent Definitions](#10-agent-definitions)
11. [Built-in Tools](#11-built-in-tools)
12. [Built-in Skills](#12-built-in-skills)
13. [Default Constitution](#13-default-constitution)
14. [Non-Functional Requirements](#14-non-functional-requirements)

---

## 1. Overview

AgentDesk is a cross-platform desktop application where AI agent teams autonomously handle the entire software development lifecycle — from planning and coding to execution and delivery. Humans approve plans, deploy, and communicate with agents.

### Core Principles

- **99% agent-driven** — humans approve, deploy, and communicate
- **Restart-safe** — agents always know where they left off via chat history + kanban state
- **Provider-agnostic** — supports Claude, OpenAI, OpenRouter, Ollama, and more from day 1
- **Plugin-first** — core functionality extensible via a plugin architecture
- **Production-quality** — each feature ships polished, tested, and reliable

### Target Users

- Solo developers who want AI to handle implementation
- Small teams that need to move fast without a full engineering team
- Tech leads who want AI to handle execution while they focus on architecture
- Non-technical founders who want to build software without hiring developers

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electrobun 1.15.1 (Bun runtime + native webview) |
| Frontend | React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI |
| Backend | Bun (TypeScript), Drizzle ORM |
| Database | SQLite (WAL mode) via `better-sqlite3` through Drizzle |
| AI | Vercel AI SDK (`ai` ^6.0) — provider-agnostic |
| AI Providers | Anthropic, OpenAI, OpenRouter, Ollama |
| Channels | Discord (discord.js), WhatsApp (baileys), Email (imapflow + nodemailer) |
| Build | Vite (frontend) + Electrobun build (app bundle) |

---

## 3. MVP Phases

| Phase | Name | Key Deliverable |
|---|---|---|
| 1 | Foundation | App shell, DB, RPC, onboarding, settings |
| 2 | Chat & Agent Intelligence | Chat UI, PM agent, sub-agents, activity pane |
| 3 | Kanban & Autonomous Workflow | Kanban board, workflow engine, plan approval |
| 4 | Plugin System & Integrations | Plugin arch, Discord, Git, deploy |
| 5 | Polish & Production Readiness | Project settings, notes, skills, inbox |
| 6 | Advanced Channels | WhatsApp, Email, unified inbox |
| 7 | Cron & Automation | Scheduled tasks, automation rules |

---

## 4. Phase 1 — Foundation

### 4.1 Desktop App Shell

**Goal**: A functioning Electrobun desktop app that launches and displays content.

- [ ] Electrobun app initialized with Bun backend + webview
- [ ] Single window, full-screen by default, resizable
- [ ] Window state persistence (size, position)
- [ ] Typed RPC bridge between Bun process and webview (all calls go through `src/shared/rpc/`)
- [ ] Configure app icon and metadata for all platforms
- [ ] Hot reload for development (frontend + main process)

**Acceptance Criteria**:
- App launches in <50ms cold start
- Typed RPC calls work bidirectionally
- Window persists position/size across restarts

### 4.2 Frontend Build Pipeline

**Goal**: React app bundled and served inside Electrobun webview.

- [ ] Vite config for React + TypeScript + Tailwind CSS 4
- [ ] shadcn/ui initialization with light theme only
- [ ] Path aliases (@/components, @/lib, @/hooks, etc.)
- [ ] ESLint + Prettier configuration
- [ ] TypeScript strict mode
- [ ] Asset pipeline (fonts, icons, images)

**Acceptance Criteria**:
- React app renders inside Electrobun webview
- Hot module replacement works during development
- Production build is optimized and tree-shaken

### 4.3 Database Layer

**Goal**: SQLite with WAL mode, Drizzle ORM, migrations, and persistent connection.

- [ ] SQLite database file in app data directory
- [ ] WAL mode enabled with optimal pragma settings:
  - `journal_mode = WAL`
  - `synchronous = NORMAL`
  - `cache_size = -64000` (64MB)
  - `foreign_keys = ON`
  - `busy_timeout = 5000`
- [ ] Drizzle ORM schema definitions for all tables
- [ ] Migration system (drizzle-kit generate + migrate) — single consolidated migration file (`v1_initial-schema.ts`)
- [ ] Persistent connection with graceful shutdown
- [ ] Database backup utility
- [ ] Seed data for default settings and agent definitions

**Core Tables (Phase 1)**:
- `settings` — global key-value settings (includes `global_workspace_path` key)
- `ai_providers` — configured AI providers with API keys (encrypted)
- `projects` — project definitions
- `agents` — agent definitions (defaults + user customizations)
- `agent_tools` — tools available to each agent

**Acceptance Criteria**:
- Database survives app crashes (WAL mode)
- Migrations run on app startup
- All queries are type-safe via Drizzle

### 4.4 Onboarding Screen

**Goal**: First-launch experience that configures the minimum required settings.

- [ ] Detect first launch (no AI providers configured)
- [ ] Step 1: Welcome screen with app description
- [ ] Step 2: Select AI provider from supported list:
  - Anthropic (Claude)
  - OpenAI
  - Z.AI
  - OpenRouter
  - Ollama (local)
- [ ] Step 3: Enter API key (with validation via test API call)
- [ ] Step 4: Select default model from provider's available models
- [ ] Step 5: Configure global workspace path (root folder for all project workspaces)
- [ ] Step 6: Confirmation + "Create First Project" CTA
- [ ] Skip option for users who want to configure later
- [ ] API key stored encrypted in settings table

**Acceptance Criteria**:
- Validates API key with a lightweight test call before proceeding
- User can go back to previous steps
- After completion, user lands on Dashboard
- Subsequent launches skip onboarding
- Global workspace path is stored in settings table under key `global_workspace_path`

### 4.5 Global Settings

**Goal**: Application-wide settings accessible from the sidebar.

**Sections**:

**AI Providers**
- [ ] List configured providers with status indicator (valid/invalid/untested)
- [ ] Add/edit/remove providers
- [ ] Per-provider fields: name, API key (masked), base URL (for OpenRouter/Ollama), default model
- [ ] Test connection button per provider
- [ ] Set default provider + model

**General**
- [ ] Global workspace path — root folder for all project workspaces (folder picker via native dialog)
- [ ] Default AI model selection (dropdown from configured providers)
- [ ] Default thinking budget (Low / Medium / High)
- [ ] Default max concurrent agents (1, 2, 3, 5, 10, 25 — default 3)
- [ ] Default shell approval mode (Ask each / Auto-approve / Allowlist)
- [ ] Default plan approval mode (Ask each / Auto-approve)
- [ ] Default shell timeout (seconds)

**Constitution**
- [ ] Global constitution text editor (markdown)
- [ ] Default constitution pre-populated (see Section 13)
- [ ] Applies to all projects unless overridden

**GitHub**
- [ ] Personal access token (encrypted storage)
- [ ] Validate token on save
- [ ] Show authenticated user info

**Appearance**
- [ ] Sidebar collapsed/expanded default
- [ ] Font size (small/medium/large)
- [ ] Compact mode toggle

**Acceptance Criteria**:
- Settings persist across restarts
- Changing default provider immediately affects new projects
- API keys are never displayed in plaintext after save

### 4.6 Dashboard

**Goal**: Home screen showing all projects with creation and management capabilities.

**Top Navbar**:
- [ ] "Import from GitHub" button (opens modal to paste repo URL)
- [ ] "+ New Project" button (opens creation modal)
- [ ] Global search (searches projects by name/description)

**Project Creation Modal**:
- [ ] Project name (required)
- [ ] Description (optional, textarea)
- [ ] Workspace path — auto-derived from global workspace path as `{globalWorkspace}/{slug}` with collision handling; can be manually overridden
- [ ] GitHub repository URL (optional)
- [ ] Working branch (optional, defaults to "main")
- [ ] Status defaults to "Active"

**Project Cards**:
- [ ] Project name (left-aligned)
- [ ] Status badge (right-aligned): Active (green), Idle (gray), Paused (yellow), Completed (blue)
- [ ] Agent count indicator
- [ ] Task count (from kanban)
- [ ] Last activity timestamp ("2 hours ago")
- [ ] Progress bar (percentage of Done tasks vs total)
- [ ] Click to open project view
- [ ] Right-click context menu: Open, Edit, Duplicate, Delete

**Sidebar** (global, collapsible):
- [ ] Inbox (with unread count badge)
- [ ] Agents (manage agent definitions)
- [ ] Cron Tasks (placeholder for Phase 5+)
- [ ] Channels (placeholder, Discord setup)
- [ ] Skills (built-in list + user-created)
- [ ] Tools (built-in tools + MCPs tab)
- [ ] Prompts (user prompt library)
- [ ] Statistics (placeholder)
- [ ] Settings (global settings)
- [ ] Collapse/expand toggle
- [ ] AgentDesk logo at top

**Search & Filter**:
- [ ] Search by project name or description
- [ ] Filter by status
- [ ] Sort by: last activity, name, creation date, progress

**Acceptance Criteria**:
- Projects load instantly from SQLite
- Creating a project auto-derives workspace path from global workspace path
- Deleting a project shows confirmation dialog and cascades all related data
- Empty state shows helpful "Create your first project" prompt

### 4.7 Reusable UI Components

**Goal**: Shared component library built on shadcn/ui used across all screens.

- [ ] Confirmation dialog (reusable, configurable title/message/actions)
- [ ] Toast notification system (success, error, warning, info)
- [ ] Modal/Sheet wrapper with consistent styling
- [ ] Sidebar component (collapsible, with sections and badges)
- [ ] Top navbar component (configurable per screen)
- [ ] Status badge component (with color variants)
- [ ] Search input with debounce
- [ ] Empty state component
- [ ] Loading skeleton components
- [ ] Avatar/icon component for agents (colored circle with initials)
- [ ] Resizable pane component (for split views)
- [ ] Keyboard shortcut handler (global)

---

## 5. Phase 2 — Chat & Agent Intelligence

### 5.1 Chat Interface

**Goal**: Full-featured chat UI for communicating with the Project Manager agent.

**Layout** (three-column when active):
```
┌──────────┬──────────────────────┬──────────────────┐
│ Conv     │  Main Chat Area      │  Activity Pane   │
│ Sidebar  │                      │                  │
│ (toggle) │                      │  (resizable)     │
│          │──────────────────────│                  │
│          │  Chat Input          │                  │
└──────────┴──────────────────────┴──────────────────┘
```

**Conversation Sidebar** (hidden by default, toggle via button):
- [ ] List of conversations with titles
- [ ] Conversation title auto-generated from first message
- [ ] Right-click menu: Pin, Rename (inline), Delete (with confirmation)
- [ ] Pinned conversations at top
- [ ] Sorted by last activity
- [ ] Search conversations

**Main Chat Area**:
- [ ] Message bubbles with agent name + colored avatar (round icon)
- [ ] Human messages styled distinctly from agent messages
- [ ] Markdown rendering for AI replies (react-markdown + rehype)
- [ ] Syntax highlighting for code blocks (shiki, all languages)
- [ ] Copy button on code blocks
- [ ] Copy and delete buttons on individual message bubbles (both human and AI)
- [ ] "Agents working..." banner at top when PM is processing
- [ ] Streaming text display (token-by-token rendering)
- [ ] Auto-scroll to bottom on new messages
- [ ] Scroll-to-bottom button when scrolled up
- [ ] Plan messages persisted to the messages DB table so they survive page reloads

**Chat Input**:
- [ ] Multi-line text area (auto-expanding)
- [ ] Send button + Enter to send (Shift+Enter for newline)
- [ ] Stop button (replaces send) when agents are working — stops all processing
- [ ] Up arrow to recall last sent message
- [ ] `/` prefix shows command palette:
  - Sub-agent shortcuts (`/tester`, `/backend-engineer`, etc.)
  - Built-in commands (`/clear`)
  - Skills (built-in + user-created)
- [ ] File upload button (documents, images)
- [ ] Disabled state when agents are working (with visual indicator)

**Slash Command Palette**:
- [ ] Triggered by typing `/` in chat input
- [ ] Filterable list of all available commands
- [ ] Sections: Agents, Commands, Skills
- [ ] Keyboard navigation (arrow keys + enter)
- [ ] Shows agent color indicators next to agent names

**Acceptance Criteria**:
- Messages stream in real-time with no visible lag
- Code blocks have correct syntax highlighting for 50+ languages
- Conversation history persists across app restarts
- File uploads attach to the next sent message
- `/clear` clears chat and resets conversation context
- Plan messages survive page reloads (loaded from DB on mount)

### 5.2 AI Provider Integration

**Goal**: Unified multi-provider AI interface using Vercel AI SDK.

- [ ] Provider adapter layer supporting:
  - Anthropic (Claude 3.5/4/4.5/4.6 Sonnet/Opus/Haiku)
  - OpenAI (GPT-4o, GPT-4.5, o1, o3)
  - Z.AI (glm)
  - OpenRouter (any model via OpenRouter API)
  - Ollama (local models)
- [ ] Vercel AI SDK `streamText()` for all providers
- [ ] Vercel AI SDK `useChat()` hook on frontend
- [ ] Tool calling support (provider-native where available, polyfill where not)
- [ ] Streaming support for all providers
- [ ] Token counting and context window management per model
- [ ] Configurable per-agent: provider, model, temperature, max tokens, thinking budget
- [ ] Fallback handling when a provider is unavailable
- [ ] API key rotation/multiple keys per provider

**Acceptance Criteria**:
- Switching providers mid-project works without data loss
- Each agent can use a different provider/model
- Streaming works identically regardless of provider
- Token usage is tracked and displayed

### 5.3 Project Manager Agent

**Goal**: The chief agent that orchestrates all work, talks to humans, and spawns sub-agents.

**System Prompt**: Battle-tested prompt (see Section 10) that instructs PM to:
- [ ] Parse human intent (project work vs. general chat)
- [ ] Decide whether to handle directly or spawn sub-agents
- [ ] Respect AGENTS.md / CLAUDE.md if present in workspace (injected into system prompt)
- [ ] Follow the Constitution (guardrails)
- [ ] Track work via kanban tasks
- [ ] Provide status updates proactively
- [ ] Resume from where it left off using chat history + kanban state
- [ ] Answer "what were we working on?" by checking current conversation + kanban
- [ ] Create, list, search, and delete projects from chat or channels

**Capabilities**:
- [ ] Spawn up to N concurrent sub-agents (configurable, default 3)
- [ ] Assign non-interdependent tasks to sub-agents
- [ ] Receive results from sub-agents and synthesize
- [ ] Present plans as chat messages for approval
- [ ] Move kanban tasks between columns
- [ ] Create notes/documents
- [ ] Access all built-in tools
- [ ] Create and manage projects via `create_project`, `list_projects`, `search_projects`, `delete_project` tools

**Acceptance Criteria**:
- PM correctly identifies when to spawn agents vs. reply directly
- PM never assigns interdependent tasks to concurrent agents
- PM resumes work correctly after app restart
- PM respects max concurrent agent limit
- PM can create projects from channel messages (Discord, WhatsApp, Email)

### 5.4 Sub-Agent Orchestration

**Goal**: PM spawns specialized agents as separate Vercel AI SDK streams.

- [ ] Each sub-agent gets:
  - Its own AI stream (independent context)
  - Specialized system prompt (from agents table)
  - Constitution appended to system prompt
  - AGENTS.md / CLAUDE.md workspace instructions appended to system prompt (same as PM)
  - Subset of tools relevant to its role
  - The specific task assigned by PM
  - Relevant project context (workspace path, kanban state)
- [ ] Sub-agent lifecycle: Spawn -> Work -> Report -> Terminate
- [ ] PM receives structured reports from sub-agents
- [ ] Concurrent execution (up to max_concurrent_agents)
- [ ] Sub-agent errors are caught and reported to PM
- [ ] PM can retry failed sub-agent tasks
- [ ] Workspace instruction files (AGENTS.md, CLAUDE.md) loaded with module-level cache; cache invalidated on workflow start

**Agent Communication Protocol**:
- [ ] PM -> Sub-agent: Task assignment with context
- [ ] Sub-agent -> PM: Progress updates, completion reports, error reports
- [ ] Sub-agents CANNOT communicate with each other directly
- [ ] Sub-agents CANNOT spawn other agents

**Acceptance Criteria**:
- 3 sub-agents can run concurrently without interference
- Sub-agent failures don't crash the PM or other agents
- All sub-agent activity is logged and visible in activity pane
- All sub-agents receive the same workspace instructions as the PM

### 5.5 Activity Pane

**Goal**: Real-time feed of all agent activity (right side of chat view).

**Header**:
- [ ] Count of currently spawned agents (e.g., "3 agents active")
- [ ] Agent filter dropdown (show all / filter by specific agent)
- [ ] Tabs: "Activity" | "Docs" (notes/documents created during conversation)

**Activity Feed** (chronological):
- [ ] Agent thinking entries (brain icon, expanded by default, collapsible)
- [ ] Tool call entries (tool-specific icons, collapsed by default, expandable)
- [ ] Tool result entries (nested under tool calls)
- [ ] Kanban task movements (e.g., "Backend Engineer moved 'Setup API' to Working")
- [ ] Sub-agent spawn/terminate events
- [ ] Review verdict events (`review_result` activity type) from code-reviewer verdicts
- [ ] Running indicator (spinner) for in-progress tool calls
- [ ] Agent name + colored avatar on each entry
- [ ] Timestamp on each entry

**Docs Tab**:
- [ ] List of notes/documents created during conversation
- [ ] Click to view in a modal or side panel
- [ ] Markdown rendered

**Resizable**:
- [ ] Divider between main chat and activity pane is draggable
- [ ] Minimum width for both panels

**Acceptance Criteria**:
- Activity updates in real-time as agents work
- Filtering by agent correctly shows only that agent's activity
- Thinking blocks are readable and expanded by default
- Tool calls show status (running/complete/error)
- Review verdict results appear in activity feed

### 5.6 Conversation Persistence

**Goal**: All conversations and messages stored in SQLite, restart-safe.

- [ ] `conversations` table: id, project_id, title, is_pinned, created_at, updated_at
- [ ] `messages` table: id, conversation_id, role (human/assistant/system/tool), agent_id, content, metadata (JSON), token_count, created_at
- [ ] `conversation_summaries` table: id, conversation_id, summary_text, messages_summarized_up_to, created_at
- [ ] Plan messages written to messages table with `metadata.isPlan: true` so they survive page reloads
- [ ] Rolling window context management:
  - Keep last N messages in full
  - Summarize older messages via AI call
  - Store summary in conversation_summaries
  - Feed [summary + recent messages] to AI
- [ ] Context window tracking per model (token counting)
- [ ] Auto-compaction triggers when context exceeds 80% of model limit

**Acceptance Criteria**:
- Conversations survive app restart
- Switching between conversations is instant
- Context summaries maintain critical project context
- Token usage stays within model limits
- Plan messages reload correctly after page refresh

---

## 6. Phase 3 — Kanban & Autonomous Workflow

### 6.1 Kanban Board

**Goal**: Interactive kanban with four columns, full drag-and-drop, agent integration.

**Columns**:
- [ ] **Backlog** (gray indicator) — tasks not yet started
- [ ] **Working** (blue indicator) — tasks in progress
- [ ] **Review** (yellow indicator) — tasks awaiting code review
- [ ] **Done** (green indicator) — completed tasks

**Task Cards**:
- [ ] Title
- [ ] Priority indicator (Critical, High, Medium, Low — color-coded)
- [ ] Assigned agent avatar
- [ ] Due date (if set)
- [ ] Blocked indicator (if blocked_by has incomplete tasks)
- [ ] Acceptance criteria progress (e.g., "2/5 criteria met")
- [ ] Click to open task detail modal

**Task Detail Modal**:
- [ ] Title (editable)
- [ ] Description (markdown, editable)
- [ ] Acceptance Criteria — checklist of `[ ]` items (agents and humans can check/uncheck)
- [ ] Important Notes — free-text area agents use for decisions (editable)
- [ ] Priority (Critical / High / Medium / Low)
- [ ] Assigned agent
- [ ] Blocked by (list of task IDs, with links)
- [ ] Due date
- [ ] Created at / Updated at
- [ ] Activity log (who moved it, who edited it, when)

**Interactions**:
- [ ] Drag and drop between columns (dnd-kit)
- [ ] Human moves task Backlog -> Working: PM auto-notified, creates conversation to work on it
- [ ] Human moves task Working -> Backlog: PM stops working on that task
- [ ] Human moves task to Done: PM acknowledges
- [ ] Create task button per column
- [ ] Edit task inline or via modal
- [ ] Delete task with confirmation
- [ ] Search tasks (title, description)
- [ ] Sort tasks within column (priority, date, manual)
- [ ] Filter by assigned agent, priority, blocked status

**Stats Bar** (above kanban or in sidebar):
- [ ] Backlog count with gray indicator
- [ ] Working count with blue indicator
- [ ] Review count with yellow indicator
- [ ] Done count with green indicator
- [ ] Workflow pipeline badge showing current WorkflowEngine state (Planning / Awaiting Approval / Executing / Done)
- [ ] Real-time updates via `workflowStateChanged` RPC broadcast

**Acceptance Criteria**:
- Drag and drop is smooth with visual feedback
- Blocked tasks show visual indicator and cannot be moved to Working
- PM reacts correctly to human task movements
- Task state persists across restarts
- Acceptance criteria checkboxes work for both humans and agents
- Stats bar pipeline badge reflects live workflow state

### 6.2 Autonomous Workflow Engine

**Goal**: Implement the standard workflow driven by WorkflowEngine state machine.

**Workflow State Machine**:

```
idle → planning → awaiting_approval → executing → done
                       ^                   ^           |          |
                       |___ rejectPlan ____|           |__ fix ___| (up to maxReviewRounds per task)
                                                                     → failed (if maxTestRounds exceeded)
```

**Workflow Steps**:

```
Step 1: Human sends feature request
Step 2: PM runs task-planner inline (via run_agent)
Step 3: task-planner calls create_note (plan doc in Docs tab)
        task-planner calls define_tasks (structured task definitions stored in WorkflowContext)
Step 4: PM calls request_plan_approval
        → Plan saved as markdown to {workspace}/plans/plan-{timestamp}.md
        → Plan presented as chat message in-app / chunked to channels
        → WorkflowEngine transitions to awaiting_approval
Step 5: Human types "approve" (or approval keyword) in chat
        → Soft approval gate in AgentEngine.sendMessage() detects keyword
        → WorkflowEngine.approvePlan() called immediately (no LLM)
        → Kanban tasks created deterministically from stored task definitions
        → WorkflowEngine transitions to executing
Step 6: WorkflowEngine dispatches agents for unblocked backlog tasks
Step 7: Each worker agent: move_task → working, does work, move_task → review
Step 8: WorkflowEngine auto-spawns code-reviewer per task when it enters review
        → code-reviewer calls submit_review(taskId, verdict, summary)
        → verdict "approved": PM moves task to done
        → verdict "changes_requested": PM dispatches fix agent (up to maxReviewRounds per task)
Step 9: All tasks done → WorkflowEngine transitions to testing
Step 10: qa-engineer runs tests; if pass → done; if fail → re-execute (up to maxTestRounds)
Step 11: PM delivers completion summary to chat + all connected channels
```

**Chat-Based Plan Approval (no modal)**:
- [ ] Plan is presented as a chat message in the conversation (not a modal dialog)
- [ ] Plan message content includes: full plan markdown + instructions ("Reply **approve** to proceed or **reject [feedback]** to request changes")
- [ ] Plan messages are written to the messages DB table and survive page reloads
- [ ] `AgentEngine.sendMessage()` checks for `awaiting_approval` workflow before passing to PM:
  - Approval keywords (`approve`, `approved`, `yes`, `go ahead`, `lgtm`, `looks good`, `go`, `start`, `proceed`) → `WorkflowEngine.approvePlan()` immediately, no LLM call
  - Rejection keywords (`reject`, `no`, `change`, `modify`, `update`, `instead`) → `WorkflowEngine.rejectPlan(feedback)` immediately, no LLM call
  - Ambiguous messages → passed to PM with context that a plan is pending
- [ ] Same mechanism works for in-app chat and all channels (Discord, WhatsApp, Email)

**Skip Approval**:
- [ ] PM can call `request_plan_approval(skip_approval: true)` to bypass the approval gate entirely
- [ ] `WorkflowEngine.startAndExecute()` creates kanban tasks and dispatches agents immediately
- [ ] Use when: workspace already has a README/PRD, user says "just do it", or work is quick/low-risk

**Rejection Flow**:
- [ ] `WorkflowEngine.rejectPlan(workflowId, feedback)` embeds feedback into workflow context
- [ ] task-planner is re-invoked with the feedback; updates plan note and regenerates task definitions
- [ ] Plan re-presented as new chat message; workflow returns to `awaiting_approval`

**Configurable Settings**:
- [ ] Max review/test rounds (default 3, in project settings — `maxReviewRounds` applies per task)
- [ ] Agent plan approval mode (Ask each time / Auto-approve)
- [ ] PM can spawn additional agents (data-engineer, security-engineer, etc.) based on task

**Acceptance Criteria**:
- Plan appears as a chat message with approval instructions (no modal)
- Approval keyword in chat triggers WorkflowEngine.approvePlan() without LLM call
- Workflow proceeds automatically after approval
- Code review loop correctly limits retries per task
- Test failure loop correctly limits retries
- PM correctly identifies non-interdependent tasks for parallel execution
- Auto-approve (skip_approval) works end-to-end without human intervention
- Plan files saved to workspace `plans/` directory

### 6.3 Plan Saving to Disk

**Goal**: Plans are persisted as markdown files in the project workspace.

- [ ] `request_plan_approval` saves plan content to `{workspace}/plans/plan-{timestamp}.md`
- [ ] Plans directory created automatically if it does not exist
- [ ] Both approval and skip-approval paths save the plan file
- [ ] Plan files are human-readable markdown for external review

**Acceptance Criteria**:
- Plan file exists on disk after `request_plan_approval` is called
- File is valid markdown matching the plan content
- Multiple plans create separate timestamped files without collision

### 6.4 Global Workspace Path & Project Workspaces

**Goal**: Single global workspace setting determines root folder for all projects.

- [ ] Global workspace path stored in `settings` table under key `global_workspace_path`
- [ ] Configured during onboarding (Step 5) or in Settings > General
- [ ] New project creation auto-derives workspace path: `{globalWorkspace}/{slugified-name}`
  - Slug: lowercase, alphanumeric + hyphens, no leading/trailing hyphens
  - Collision handling: append numeric suffix (`-1`, `-2`, etc.)
- [ ] User can manually override the path in the project creation modal
- [ ] PM's `create_project` tool uses the global workspace path for channel-created projects

**Acceptance Criteria**:
- Projects created in-app and via channels get auto-derived workspace paths
- Name collisions are handled without error
- Workspace path is a valid filesystem path under the global workspace root

### 6.5 Agent Tools System

**Goal**: Built-in tools that agents use to work autonomously on projects.

**File Operations**:
- [ ] `read_file` — read file contents (with line range support)
- [ ] `write_file` — create or overwrite a file
- [ ] `edit_file` — surgical string replacement in a file
- [ ] `list_directory` — list files/folders in a path
- [ ] `search_files` — glob pattern file search
- [ ] `search_content` — grep/regex content search across files
- [ ] `delete_file` — delete a file (with safety checks)
- [ ] `move_file` — move or rename a file

**Shell Operations**:
- [ ] `run_shell` — execute shell commands with stdout/stderr capture
- [ ] Approval modes: Ask each / Auto-approve / Allowlist
- [ ] Blocked command patterns (rm -rf /, format, etc.)
- [ ] Configurable timeout (default 120s)
- [ ] Working directory scoped to project workspace

**Kanban Operations**:
- [ ] `create_task` — create a kanban task
- [ ] `update_task` — update task fields
- [ ] `move_task` — move between columns; "done" destination blocked for worker agents (PM-only via `finalize_task_review`)
- [ ] `check_criteria` — check/uncheck acceptance criteria items; all criteria must be checked before `move_task → review`
- [ ] `add_task_notes` — add to important notes section
- [ ] `list_tasks` — list tasks with optional filters
- [ ] `get_task` — get full task details
- [ ] `submit_review` — structured review verdict tool for code-reviewer agent (see Section 11)

**Notes Operations**:
- [ ] `create_note` — create a document (markdown)
- [ ] `update_note` — edit existing note
- [ ] `list_notes` — list all project notes
- [ ] `get_note` — read a note's content

**Communication**:
- [ ] `report_to_pm` — sub-agent reports back to PM
- [ ] `request_human_input` — agent asks human a question (shows in chat)

**Acceptance Criteria**:
- All file operations are scoped to project workspace (no escape)
- Shell commands respect approval mode and blocked patterns
- Kanban tools correctly update the board and notify relevant parties
- Tools have proper error handling and return structured results
- Worker agents receive an error if they attempt `move_task → done`

---

## 7. Phase 4 — Plugin System & Integrations

### 7.1 Plugin Architecture

**Goal**: Full plugin system that allows extending AgentDesk functionality.

**Plugin Structure**:
```
plugins/
  my-plugin/
    manifest.json    # name, version, description, author, permissions
    index.ts         # entry point (main process code)
    ui/              # optional frontend components
    tools/           # optional agent tools
    skills/          # optional agent skills
```

**Plugin Manifest** (`manifest.json`):
- [ ] `name` — unique identifier
- [ ] `displayName` — human-readable name
- [ ] `version` — semver
- [ ] `description` — what the plugin does
- [ ] `author` — creator info
- [ ] `permissions` — what the plugin can access (fs, shell, network, etc.)
- [ ] `tools` — agent tools provided by this plugin
- [ ] `skills` — agent skills provided by this plugin
- [ ] `hooks` — lifecycle hooks (onInstall, onEnable, onDisable, onUninstall)
- [ ] `settings` — plugin-specific settings schema

**Plugin Loader**:
- [ ] Scan `plugins/` directory on startup
- [ ] Load and validate manifests
- [ ] Initialize enabled plugins
- [ ] Dependency resolution between plugins
- [ ] Hot-reload during development

**Plugin Registry UI** (in sidebar > Tools):
- [ ] List installed plugins with enable/disable toggle
- [ ] Plugin detail view (description, version, permissions, settings)
- [ ] Built-in plugins section
- [ ] User plugins section
- [ ] Install from directory button

**Plugin API**:
- [ ] `registerTool(toolDefinition)` — add agent tools
- [ ] `registerSkill(skillDefinition)` — add agent skills
- [ ] `registerHook(event, handler)` — hook into app lifecycle
- [ ] `getSettings()` / `setSettings()` — plugin settings
- [ ] `getProjectContext()` — current project info
- [ ] `emitEvent(event, data)` — plugin events
- [ ] Sandboxed execution (plugins cannot access other plugin internals)

**Built-in Plugins** (ship with app):
- [ ] `chrome-devtools-mcp` — browser automation for agents (see 7.2)

**Acceptance Criteria**:
- Plugins load without affecting app startup time (<100ms overhead)
- Disabling a plugin cleanly removes its tools/skills
- Plugin errors don't crash the main application
- Plugin settings persist across restarts

### 7.2 Chrome DevTools MCP Plugin

**Goal**: Browser automation plugin so agents can test web applications.

- [ ] Integrates chrome-devtools-mcp (https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [ ] Provides agent tools: navigate, click, type, screenshot, evaluate JS, get DOM
- [ ] Launches headless Chrome when needed
- [ ] Configurable Chrome path
- [ ] Plugin manifest with network + shell permissions

**Acceptance Criteria**:
- Agents can navigate to URLs, interact with pages, and capture screenshots
- Works headlessly (no visible browser window by default)
- Plugin can be disabled without affecting other functionality

### 7.3 Discord Integration

**Goal**: Communicate with PM agent via Discord bot.

- [ ] Discord bot setup wizard in Channels settings
  - Bot token configuration
  - Server and channel selection
  - Permission verification
- [ ] Bidirectional messaging:
  - Human messages on Discord -> PM inbox + processing
  - PM replies -> Discord channel
- [ ] PM intelligence: distinguish project work requests from general chat
- [ ] Message formatting (markdown -> Discord markdown)
- [ ] Status updates posted to Discord when tasks complete
- [ ] Configurable per-project (which projects the bot listens for)
- [ ] PM can create projects from Discord messages using `create_project` tool

**Acceptance Criteria**:
- Messages from Discord arrive in PM inbox within 2 seconds
- PM can process Discord messages and reply automatically
- PM correctly routes project-specific requests
- Bot handles connection drops and reconnects
- PM can create a new project via Discord without requiring the in-app UI

### 7.4 Git Integration

**Goal**: Version control management within the project view.

**Git Tab** (in project sidebar):
- [ ] Branch list with current branch indicator
- [ ] Create branch from current
- [ ] Switch branches
- [ ] Commit history (log with author, message, date, hash)
- [ ] Diff viewer (file-level changes)
- [ ] Stage/unstage files
- [ ] Commit with message
- [ ] Push to remote
- [ ] Pull from remote

**Agent Git Tools**:
- [ ] `git_status` — current repo status
- [ ] `git_diff` — view changes
- [ ] `git_commit` — stage and commit changes
- [ ] `git_branch` — create/switch branches
- [ ] `git_push` — push to remote (requires human approval by default)

**Auto-Commit Settings** (per project):
- [ ] Commit on task completion (toggle)
- [ ] Commit message format (conventional commits, custom template)
- [ ] Branch naming convention

**Acceptance Criteria**:
- Git operations work for any repository (not just Node projects)
- Push to remote requires human approval by default
- Branch list updates in real-time
- Diff viewer handles large files gracefully

### 7.5 Basic Deploy

**Goal**: Deploy to configured environments via saved scripts.

**Deploy Tab** (in project sidebar):
- [ ] Environment list (Staging, Production, custom)
- [ ] Per-environment config:
  - Branch
  - Deploy command (shell script)
  - URL (for verification)
- [ ] "Deploy" button per environment
- [ ] Deploy confirmation dialog with environment details
- [ ] Deploy log (real-time streaming of command output)
- [ ] Deploy history (timestamp, environment, status, duration, who triggered)

**Acceptance Criteria**:
- Deploy executes the configured shell command
- Real-time log output during deployment
- Deploy history persists across restarts
- Failed deploys show error details

---

## 8. Phase 5 — Polish & Production Readiness

### 8.1 Project Settings

**Goal**: Full project-level settings that override global defaults.

**General Tab**:
- [ ] Project Name, Description, Status
- [ ] Workspace Path (with folder picker; defaults to auto-derived path from global workspace)
- [ ] GitHub Repository URL
- [ ] Working Branch

**AI Tab**:
- [ ] AI Model override (provider + model)
- [ ] Max Concurrent Agents
- [ ] Thinking Budget (Low / Medium / High)
- [ ] System Prompt override
- [ ] Constitution override (inherits global, can extend or replace)
- [ ] Shell Approval Mode
- [ ] Agent Plan Approval Mode
- [ ] Allowed Shell Patterns (allowlist)
- [ ] Blocked Tools
- [ ] Shell Timeout
- [ ] Max Review/Test Rounds

**Deployments Tab**:
- [ ] Staging: branch, command, URL
- [ ] Production: branch, command, URL
- [ ] Custom environments

**Integrations Tab**:
- [ ] GitHub webhook URL (auto-generated)
- [ ] Webhook secret
- [ ] GitHub authentication status
- [ ] Discord channel override

**Danger Zone**:
- [ ] "Delete Project" red button with confirmation dialog
- [ ] Cascading delete: all conversations, messages, tasks, notes, deploys, settings

### 8.2 Notes & Documents

**Goal**: Agent-created and human-editable documents within a project.

**Notes Tab** (in project sidebar):
- [ ] List of documents with title, author (agent or human), last modified
- [ ] Create new note button
- [ ] Markdown editor (raw markdown editing)
- [ ] Preview toggle (rendered markdown)
- [ ] Notes created by agents (PRDs, architecture docs, decisions, plans)
- [ ] Humans can edit any note
- [ ] Delete note with confirmation
- [ ] Search notes by title/content

**Docs Tab in Activity Pane**:
- [ ] Shows notes created during current conversation
- [ ] Quick view without leaving chat

**Acceptance Criteria**:
- Agents can create/update notes via tools
- Humans can edit agent-created notes
- Notes persist across conversations and restarts

### 8.3 LSP Diagnostics

**Goal**: Basic language server diagnostics fed to agents.

- [ ] Detect project language from workspace files (package.json, Cargo.toml, go.mod, etc.)
- [ ] Launch appropriate language server (TypeScript, Python, Go, Rust, etc.)
- [ ] Capture diagnostics (errors, warnings)
- [ ] Feed diagnostics to agents after file edits
- [ ] Agent tool: `get_diagnostics` — returns current errors/warnings
- [ ] Configurable: enable/disable per project

**Acceptance Criteria**:
- TypeScript/JavaScript diagnostics work out of the box
- Agents receive diagnostics within 2 seconds of file save
- Language servers don't consume excessive memory

### 8.4 Inbox

**Goal**: Centralized inbox for all human-agent communications across channels.

- [ ] Global inbox (sidebar) — messages from all projects
- [ ] Project inbox — messages for specific project
- [ ] Unread count badges (real-time)
- [ ] Message list with: sender, channel (chat/discord), preview, timestamp
- [ ] Click to open conversation or respond
- [ ] Mark as read/unread
- [ ] Filter by project, channel, agent

### 8.5 Prompts Library

**Goal**: User-created prompt templates accessible from chat.

- [ ] CRUD for prompts: name, description, content (markdown)
- [ ] Searchable dropdown in chat top navbar
- [ ] Click to inject prompt into chat input
- [ ] Built-in prompt templates (e.g., "Code Review", "Add Feature", "Fix Bug")
- [ ] Category/tag support

### 8.6 Agent Management UI

**Goal**: Full agent customization interface.

**Agents Page** (sidebar):
- [ ] List all agents (PM + sub-agents)
- [ ] Per-agent settings:
  - Display name
  - Internal name (read-only for built-in)
  - Color (with color picker, auto-assigned by default)
  - System prompt (markdown editor, shows default with option to customize)
  - AI provider override
  - Model override
  - Temperature
  - Max tokens / context length
  - Thinking budget (Low / Medium / High)
  - Enabled/disabled toggle
- [ ] PM-specific settings:
  - Max concurrent agents
- [ ] Add custom agent button
- [ ] Reset to defaults button per agent
- [ ] Preview of agent avatar (colored circle with initials)

### 8.7 Skills System

**Goal**: Built-in and user-created skills for agents.

**Skills Page** (sidebar):
- [ ] Built-in skills list (see Section 12)
- [ ] User-created skills tab
- [ ] Per-skill: name, description, trigger pattern, prompt template
- [ ] Enable/disable per skill
- [ ] Create new skill wizard

### 8.8 Keyboard Shortcuts & Search

- [ ] Global command palette (Cmd/Ctrl + K)
- [ ] Navigate between projects (Cmd/Ctrl + 1-9)
- [ ] Focus chat input (Cmd/Ctrl + L)
- [ ] Toggle sidebar (Cmd/Ctrl + B)
- [ ] Toggle activity pane (Cmd/Ctrl + .)
- [ ] Search everything (projects, conversations, tasks, notes)

### 8.9 Loop Detection & Safety

- [ ] Detect agent loops (same action repeated 3+ times with no progress)
- [ ] Auto-pause and notify human
- [ ] Conversation auto-compaction when approaching context limits
- [ ] Graceful degradation when API rate limits hit
- [ ] Agent timeout per action (configurable)

---

## 9. Database Schema Overview

### Core Tables

```
settings
  id, key (unique), value (JSON), category, created_at, updated_at
  Notable keys: "global_workspace_path", "constitution", "workflow:<conversationId>"

ai_providers
  id, name, provider_type, api_key (encrypted), base_url, default_model,
  is_default, is_valid, created_at, updated_at

projects
  id, name, description, status (active/idle/paused/completed),
  workspace_path, github_url, working_branch, settings (JSON overrides),
  created_at, updated_at

agents
  id, name, displayName, color, system_prompt, provider_id,
  model_id, temperature, max_tokens, thinking_budget, is_pm, is_enabled,
  is_custom, created_at, updated_at

agent_tools
  id, agent_id, tool_name, is_enabled

conversations
  id, project_id, title, is_pinned, created_at, updated_at

messages
  id, conversation_id, role, agent_id, content, metadata (JSON),
  token_count, created_at
  Notable metadata fields: isPlan (boolean), workflowId, planContent

conversation_summaries
  id, conversation_id, summary_text, messages_up_to_id, created_at

kanban_tasks
  id, project_id, title, description, acceptance_criteria (JSON array),
  important_notes, column (backlog/working/review/done),
  priority (critical/high/medium/low), assigned_agent_id,
  blocked_by (JSON array of task IDs), review_rounds, due_date,
  position (sort order), created_at, updated_at

kanban_task_activity
  id, task_id, action (created/moved/edited/assigned), agent_id,
  details (JSON), created_at

notes
  id, project_id, conversation_id, title, content (markdown),
  author_type (agent/human), author_id, created_at, updated_at

deploy_environments
  id, project_id, name, branch, command, url, created_at, updated_at

deploy_history
  id, environment_id, status (pending/running/success/failed),
  log_output, triggered_by, duration_ms, created_at

prompts
  id, name, description, content, category, created_at, updated_at

plugins
  id, name, display_name, version, description, is_enabled, is_builtin,
  settings (JSON), created_at, updated_at

channels
  id, type (discord/telegram/whatsapp), config (JSON encrypted),
  is_enabled, project_id, created_at, updated_at

inbox_messages
  id, project_id, channel_id, sender, content, is_read,
  agent_response, created_at

cron_jobs
  id, project_id, name, schedule (cron expression), command,
  next_run_at, last_run_at, is_enabled, created_at, updated_at

message_parts
  id, message_id, type, content, tool_name, tool_input, tool_output, tool_state, sort_order, time_start, time_end, created_at

skills
  id, name, description, trigger_pattern, prompt_template,
  is_builtin, is_enabled, created_at, updated_at
```

> Workflow state is persisted in the `settings` table under key `workflow:<conversationId>` for crash recovery.

---

## 10. Agent Definitions

### Project Manager

**Internal Name**: `project-manager`
**Display Name**: Project Manager
**Role**: Chief orchestrator. Talks to humans, spawns sub-agents, manages workflow. Can create and manage projects from chat and channels.

**Default System Prompt** (summary):
```
You are the Project Manager agent for AgentDesk.

ROLE:
- Primary point of contact between the human and all sub-agents
- Orchestrate the entire development workflow
- Make decisions about which agents to spawn and when
- Maintain project state via kanban tasks
- Create and manage projects when requested

WORKFLOW:
1. Analyze human requests carefully
2. For complex tasks:
   - Delegate to task-planner (who calls create_note + define_tasks)
   - Call request_plan_approval — plan is presented as a chat message
   - Wait for "approve" keyword in chat (or set skip_approval: true)
   - After approval, kanban tasks are created automatically
   - Worker agents dispatch and report back
3. For simple tasks: handle directly or spawn a single agent
4. Always ensure tasks assigned to concurrent agents are NOT interdependent
5. After agent work: code-reviewer runs per task (via submit_review)
   → pass: PM moves to done; fail: PM sends back (max maxReviewRounds per task)
   → after all tasks: qa-engineer tests

RESTART SAFETY:
- When asked "what were we working on?", check conversation history AND kanban tasks
- Always be able to resume from where you left off

COMMUNICATION:
- Be concise and professional
- Proactively update humans on progress
- Ask for clarification when requirements are ambiguous

CONSTITUTION:
{constitution}

WORKSPACE INSTRUCTIONS:
If the workspace contains AGENTS.md or CLAUDE.md, their contents are injected
automatically into the system prompt and MUST be followed.
```

### Sub-Agents

| Agent | Internal Name | Role |
|---|---|---|
| Software Architect | `software-architect` | System design, architecture decisions, tech stack, database schema |
| Backend Engineer | `backend-engineer` | Server-side code, APIs, database queries, business logic |
| Frontend Engineer | `frontend_engineer` | UI components, React/TypeScript, styling, browser-side logic |
| Code Reviewer | `code-reviewer` | Review code; calls `submit_review(taskId, verdict, summary)` — verdict is `approved` or `changes_requested` |
| Task Planner | `task-planner` | Break down requirements; calls `create_note` (plan doc) and `define_tasks` (task definitions) |
| QA Engineer | `qa-engineer` | Test writing, test plans, quality assurance, regression checks |
| DevOps Engineer | `devops-engineer` | CI/CD, deployment, infrastructure, monitoring |
| Documentor | `documentation-expert` | Technical docs, API docs, user guides, READMEs |
| Performance Engineer | `performance-expert` | Profiling, optimization, benchmarking |
| Security Engineer | `security-expert` | Security review, vulnerability assessment, secure coding |
| UI/UX Designer | `ui-ux-designer` | Design mockups, user flows, accessibility, design systems |
| Data Engineer | `data-engineer` | Data pipelines, ETL, data modeling, migrations |
| Debugging Specialist | `debugging-specialist` | Root-cause analysis, bug investigation, log analysis |
| Explorer | `explore` | Research, codebase exploration, web search, URL fetching, documentation lookup. Read-only — never writes files |

Each sub-agent receives:
- Specialized system prompt from the agents table
- Constitution from the settings table
- AGENTS.md / CLAUDE.md workspace instructions (same injection as PM)
- Subset of tools relevant to their role

---

## 11. Built-in Tools

### File Tools
| Tool | Description | Available To |
|---|---|---|
| `read_file` | Read file contents with optional line range | All agents |
| `write_file` | Create or overwrite a file | Engineers, Architect |
| `edit_file` | Surgical string replacement | Engineers, Architect |
| `list_directory` | List files and folders | All agents |
| `search_files` | Glob pattern file search | All agents |
| `search_content` | Regex search across files | All agents |
| `delete_file` | Delete file (safety-checked) | Engineers |
| `move_file` | Move or rename file | Engineers |

### Shell Tools
| Tool | Description | Available To |
|---|---|---|
| `run_shell` | Execute shell command | All agents (approval mode) |

### PM Tools
| Tool | Description | Available To |
|---|---|---|
| `run_agent` | Run a sub-agent inline in the main conversation. Agent gets fresh context (system prompt + task only). Tool calls visible as message parts. | PM only |
| `run_agents_parallel` | Run multiple independent agents in parallel inline. Each gets its own fresh context. | PM only |
| `request_plan_approval` | Present plan as chat message for approval; saves plan to `{workspace}/plans/`; optionally skip approval (`skip_approval: true`) | PM only |
| `create_project` | Create a new project; workspace auto-derived from global workspace path | PM only |
| `list_projects` | List all projects with basic stats | PM only |
| `search_projects` | Fuzzy-search projects by name and description (word-level scoring) | PM only |
| `delete_project` | Delete a project and all data (requires project ID + exact name confirmation) | PM only |

### Task-Planner Tools
| Tool | Description | Available To |
|---|---|---|
| `create_note` | Create a markdown plan document in the Docs tab | Task Planner |
| `define_tasks` | Store structured task definitions in WorkflowContext (does NOT create kanban tasks) | Task Planner |
| `create_task` | Create a kanban task (post-approval and during test-fix phases only) | PM, Task Planner |

### Kanban Tools
| Tool | Description | Available To |
|---|---|---|
| `update_task` | Update task fields | PM, Task Planner |
| `move_task` | Move between columns. Worker agents may use backlog/working/review only. "done" is PM-only | PM and worker agents |
| `check_criteria` | Check acceptance criteria items. All criteria must be checked before `move_task → review` | All agents |
| `add_task_notes` | Append notes to a task's important notes section | All agents |
| `list_tasks` | List/filter tasks | All agents |
| `get_task` | Get full task details including acceptance criteria | All agents |
| `submit_review` | Submit a structured code review verdict (`approved` or `changes_requested`) with summary. Processed by `WorkflowEngine.handleReviewVerdict()`. Backward-compatible heuristic text analysis is kept as fallback | Code Reviewer only |

### Notes Tools
| Tool | Description | Available To |
|---|---|---|
| `create_note` | Create a document (markdown) | All agents |
| `update_note` | Edit a note | All agents |
| `list_notes` | List project notes | All agents |
| `get_note` | Read note content | All agents |

### Git Tools
| Tool | Description | Available To |
|---|---|---|
| `git_status` | Repository status | All agents |
| `git_diff` | View changes | All agents |
| `git_commit` | Stage and commit | Engineers, DevOps |
| `git_branch` | Branch operations | Engineers, DevOps |
| `git_push` | Push to remote | DevOps (approval required) |

### Communication Tools
| Tool | Description | Available To |
|---|---|---|
| `report_to_pm` | Report results to PM | Sub-agents |
| `request_human_input` | Ask human a question (shows in chat) | All agents |

### Diagnostic Tools
| Tool | Description | Available To |
|---|---|---|
| `get_diagnostics` | Get LSP errors/warnings | Engineers |

---

## 12. Built-in Skills

| Skill | Description | Trigger |
|---|---|---|
| `plan-project` | Create a comprehensive project plan | PM determines need |
| `review-code` | Thorough code review with checklist | `/review` or PM assigns |
| `write-tests` | Generate tests for code | `/test` or PM assigns |
| `fix-bug` | Analyze and fix a reported bug | `/fix` or PM assigns |
| `refactor` | Improve code structure | `/refactor` or PM assigns |
| `document` | Generate documentation | `/document` or PM assigns |
| `security-audit` | Run security checks | `/security` or PM assigns |
| `performance-audit` | Profile and optimize | `/performance` or PM assigns |
| `deploy` | Execute deployment | `/deploy` or human triggers |
| `git-commit` | Stage, commit, push | `/commit` or task completion |

---

## 13. Default Constitution

```markdown
## AgentDesk Agent Constitution

### Safety
- NEVER execute destructive commands (rm -rf /, format, drop database) without explicit human approval
- NEVER access files outside the project workspace directory
- NEVER expose API keys, secrets, or credentials in code, logs, or chat
- NEVER make network requests to unknown or unauthorized endpoints
- NEVER modify system files or configurations outside the project

### Code Quality
- Follow the project's existing code style and conventions
- Write code that is readable, maintainable, and well-structured
- Include error handling for all external operations (I/O, network, parsing)
- Do not introduce known security vulnerabilities (OWASP Top 10)
- Prefer simple solutions over clever ones

### Communication
- Be honest about limitations and uncertainties
- Report errors and failures immediately to PM
- Ask for clarification rather than making risky assumptions
- Provide concise, actionable status updates

### Autonomy Boundaries
- Agents may read any file in the workspace
- Agents may write/edit files in the workspace
- Agents must request approval for shell commands (unless auto-approve is on)
- Agents must NEVER push to remote without human approval (even with auto-approve)
- Agents must NEVER deploy to production without human approval
- Agents must follow the approved plan — deviations require PM approval

### Resource Limits
- Respect token budgets and context limits
- Do not create unnecessary files or bloat the codebase
- Clean up temporary files after use
```

---

## 14. Non-Functional Requirements

### Performance
- App cold start: <50ms (Electrobun target)
- SQLite query response: <10ms for common queries
- Chat message streaming: first token visible within 500ms of send
- Kanban drag-and-drop: 60fps animation
- Activity pane updates: <100ms latency

### Reliability
- SQLite WAL mode prevents corruption on crash
- All agent state persisted to DB (restart-safe)
- Workflow state persisted to `settings` table under `workflow:<conversationId>` for crash recovery
- Graceful error handling — no unhandled exceptions crash the app
- Agent failures isolated (one agent crash doesn't affect others)

### Security
- API keys encrypted at rest (AES-256 or platform keychain)
- Shell commands sandboxed to workspace directory
- Plugin execution sandboxed
- No remote code execution vulnerabilities

### Usability
- Light theme only (clean, professional)
- Responsive layout (minimum 1024x768)
- Keyboard navigable (a11y)
- All destructive actions require confirmation
- Loading states for all async operations

### Testing
- Unit tests for all business logic (database, agent orchestration, tools)
- Integration tests for RPC bridge
- Component tests for critical UI components
- E2E tests for core workflows (create project, chat, kanban)

### Code Quality
- TypeScript strict mode
- ESLint + Prettier enforced
- Modular architecture (clear separation of concerns)
- KISS, DRY, SOLID principles
- Reusable components

---

## Phase 6 — Advanced Channels & Communication

### 6.1 WhatsApp Integration

- WhatsApp Web bridge (unofficial, for personal use)
- QR code scanning for WhatsApp Web bridge
- Bidirectional messaging
- Media support (images, documents)
- Template messages for structured updates
- Session persistence across app restarts

### 6.2 Unified Inbox Enhancements

- Threaded conversations per channel
- Priority inbox (urgent messages surface first)
- Auto-categorization (project work, general chat, reminders, status updates)
- Bulk actions (mark all read, archive)
- Notification preferences per channel (sound, badge, banner)
- Smart notifications (don't notify for automated status updates unless configured)
- Inbox rules (auto-route messages based on keywords/patterns)

### 6.3 Email Integration

- IMAP/SMTP configuration
- PM agent can receive and reply to emails
- Email-to-task conversion
- Digest emails (daily/weekly project summaries)

---

## Phase 7 — Cron Tasks & Automation

### 7.1 Cron Task Engine

- In-app scheduler with SQLite persistence
- Cron expression support (standard 5-field + seconds)
- Human-readable schedule builder UI (every day at 10am, every 3 hours, etc.)
- Natural language schedule parsing ("remind me every morning at 9am")
- Task types:
  - PM agent prompt (send a message to PM as if human typed it)
  - Reminder (notification to human)
  - Shell command (run a script)
  - Webhook (call an external URL)
  - Agent task (spawn an agent to do something)
- Missed task recovery on app restart (recalculate, run if overdue)
- Task execution history with logs
- Enable/disable individual tasks
- One-time scheduled tasks (run once at specific datetime, then auto-disable)
- Timezone-aware scheduling
