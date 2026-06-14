# AgentDesk Project Analysis

> ⚠️ **STATUS: STALE SNAPSHOT (~v1.x).** This analysis predates roughly 11 subsystems
> (freelance/Auto-Earn, issue-fixer, multi-source issues, remote-sync, playground, mcp,
> notifications, annotations, claude, lib, rpc-groups) and stops at migration ~v10 of 43.
> The core architecture sections still hold, but counts and structure are out of date.
> Current source of truth: `project-wiki/` (`overview.md` + `reference/directory-map.md`).

Comprehensive analysis of the AgentDesk AI-powered development platform.

## 1. Project Purpose

AgentDesk is a cross-platform desktop application that enables autonomous AI agent teams to handle the full software development lifecycle — planning, coding, reviewing, and testing — while humans approve plans and deployments only. The platform orchestrates a team of specialized AI agents through a Project Manager (PM) that communicates with humans, creates plans, spawns sub-agents, and manages a kanban board.

**Motto**: 99% agent-driven. Humans approve, deploy, and communicate.

The application solves the problem of coordinating multiple AI agents for development work by providing:
- Centralized agent orchestration through a Project Manager
- Approval workflow for human oversight
- Kanban-based task tracking
- Inline agent execution with visible tool calls
- Automatic code review cycle
- Multi-channel communication support (Discord, WhatsApp, Email)

## 2. Architecture Overview

### Tech Stack

**Desktop Framework**: Electrobun 1.16.0 (Bun runtime + native WebView2)
- Provides cross-platform desktop app capabilities
- Manages webview for React frontend
- Handles IPC between Bun backend and webview

**Frontend**: React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI
- Modern React 19 for UI components
- TanStack Router for routing
- Zustand for state management
- Tailwind CSS for styling
- Radix UI for primitive UI components

**Backend**: Bun (TypeScript), Drizzle ORM
- Bun runtime for server-side logic
- TypeScript for type safety
- Drizzle ORM for database operations

**Database**: SQLite (WAL mode) via better-sqlite3 through Drizzle
- SQLite with Write-Ahead Logging for concurrent access
- Drizzle ORM for schema management and queries
- Stored in user data directory

**AI SDK**: Vercel AI SDK (`ai` ^6.0) — provider-agnostic
- Unified interface for multiple AI providers
- Streaming support for real-time responses
- Tool calling capabilities

**AI Providers**: Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, xAI Grok, OpenRouter, Ollama
- Multiple provider support for flexibility
- Local model support via Ollama
- Provider adapter pattern for extensibility

**Channels**: Discord (discord.js), WhatsApp (baileys), Email (imapflow + nodemailer)
- Discord bot integration via discord.js
- WhatsApp via baileys library
- Email via IMAP (receive) and SMTP (send)

**Build**: Vite (frontend) + Electrobun build (app bundle)
- Vite for fast frontend builds
- Electrobun for desktop app packaging

### Key Architectural Patterns

**Inline Agent Execution**
- Sub-agents run inline in the main conversation via `run_agent` / `run_agents_parallel`
- Each agent gets fresh context (system prompt + task description only)
- Tool calls visible as message parts in chat
- No persistent agent sessions — stateless model

**Sequential Single-Agent Model**
- Write agents execute one at a time, sequentially
- Read-only agents (`code-explorer`, `research-expert`, `task-planner`) can run in parallel
- Enforced via `writeAgentRunning` closure guard in PM tools
- Prevents conflicts between concurrent write operations

**RPC Pattern**
- All frontend → backend calls go through Electrobun's typed RPC system
- Contracts: `src/shared/rpc/*.ts` — define input/output shapes
- Handlers: `src/bun/rpc/*.ts` — implement the logic
- Registration: `src/bun/rpc-registration.ts` — wires handlers to Electrobun
- Client: `src/mainview/lib/rpc.ts` — typed caller used by React components

**PM as Sole Orchestrator**
- No separate WorkflowEngine state machine
- PM handles planning, approval, task creation, and agent dispatch directly
- Workflow state tracked in PM's conversation context and kanban board
- Kanban flow: backlog → working → review → done

**Automatic Code Review**
- When a task moves to "review", `review-cycle.ts` automatically spawns a code-reviewer
- On `submit_review(approved)` → task moved to done
- On rejection → back to working (up to `maxReviewRounds`, default 2)

### Main Components and Their Roles

**AgentEngine** (`src/bun/agents/engine.ts`)
- Streams PM responses
- Runs inline sub-agents
- Hosts soft approval gate for pending plans
- Manages conversation state and context

**Agent Loop** (`src/bun/agents/agent-loop.ts`)
- Inline sub-agent executor
- Runs agents with message parts for visibility
- Exports `READ_ONLY_AGENTS` set for parallel execution

**Review Cycle** (`src/bun/agents/review-cycle.ts`)
- Standalone code review cycle
- Auto-spawns code-reviewer when task enters "review" column
- No WorkflowEngine dependency

**Engine Manager** (`src/bun/engine-manager.ts`)
- Creates and caches AgentEngine per project
- Global abort controller registry
- Broadcasts notifications via channels

**Channel Manager** (`src/bun/channels/manager.ts`)
- Routes inbound messages from external channels
- Broadcasts task notifications to channels
- Manages channel adapter lifecycle

**Skills System** (`src/bun/skills/`)
- Filesystem-based skill extension system
- Two locations: bundled (`skills/`) and user (`{userData}/skills/`)
- Parses SKILL.md files with YAML frontmatter
- Skills are agent instructions for specialized tasks

## 3. Core Features

### Planning and Approval Workflow
1. User describes a task in chat
2. PM creates a plan → user approves
3. PM creates kanban tasks and dispatches specialist agents
4. Agents write code, commit to feature branch, move tasks through board
5. Code reviewer auto-spawns when task reaches "review" column
6. Completed work is summarized back to user

### Kanban Task Management
- Four columns: backlog → working → review → done
- Tasks can't skip columns
- Move to "done" reserved for review system via `submit_review`
- Task cards show acceptance criteria, assignee, priority
- Stats bar shows per-column task counts

### Agent System
- **21 built-in agents** with specialized roles
- 3 read-only agents that can run in parallel
- Write agents execute sequentially one at a time
- Each agent has configurable tools, provider, model
- Inline execution with visible tool calls
- Handoff summaries between sequential agents

### External Channels
- **Discord**: Bot connects to server, posts updates, receives commands
- **WhatsApp**: QR-code pairing, bidirectional messaging
- **Email**: IMAP for receiving, SMTP for sending
- Two-way sync between channels and in-app chat

### Developer Tools Integration
- **LSP (Language Server Protocol)**: Code intelligence via TypeScript, Python, Go, Rust LSPs
- **Git Integration**: Status, branches, commits, pull requests, conflicts
- **GitHub Integration**: Issues, pull requests, webhooks, branch strategy
- **Screenshot Capture**: Preview web applications
- **Shell Commands**: Safe shell execution with approval gate
- **File Operations**: Read/write/edit/search with file tracking

### Plugin System
- Load external plugins at runtime
- Plugins can register tools, hooks, UI extensions
- Plugin API: tools, settings, file change callbacks, sidebar items
- LSP server management via plugin

### Skills Extension
- Filesystem-based skill system (SKILL.md files)
- Built-in skills bundled with app
- User skills stored in `{userData}/skills/`
- YAML frontmatter for skill metadata
- Compatible with Claude Code / Agent Skills standard

### Automation & Scheduling
- Cron-based job scheduler
- Event-triggered automation rules
- Event bus for internal pub/sub
- Scheduled tasks with history tracking

### Deployment Management
- Configure deploy environments (staging, production)
- Track deploy history
- Execute deploy commands
- Deploy status monitoring

## 4. Project Structure

```
src/
├── bun/                  # Bun backend (main process)
│   ├── agents/           # Agent engine, PM tools, sub-agent executor, review cycle
│   │   ├── tools/        # All agent tool implementations
│   ├── db/               # Drizzle schema, migrations, seed data
│   ├── rpc/              # RPC handlers (one file per domain)
│   ├── channels/         # External channel adapters (Discord, WhatsApp, Email)
│   ├── providers/        # AI provider adapters + model catalogue
│   ├── scheduler/        # Cron jobs + automation engine
│   ├── skills/           # Skill loader and registry
│   ├── plugins/          # Plugin system + LSP server management
│   ├── discord/          # Discord bot
│   └── lsp/             # LSP client and server management
│
├── mainview/             # React frontend (rendered in Electrobun webview)
│   ├── pages/            # Route pages (dashboard, project, settings, inbox, etc.)
│   ├── components/       # UI components (chat, kanban, git, deploy, etc.)
│   ├── stores/           # Zustand state stores
│   └── lib/             # RPC client, utilities
│
└── shared/               # Types shared between Bun and frontend
    └── rpc/             # RPC contract definitions (source of truth for API shape)

skills/                  # Built-in skills (copied into app bundle)
docs/                    # Documentation files
plugins/                 # External plugins
```

**Key Directraries**:
- `src/bun/agents/`: Core agent orchestration logic
- `src/bun/agents/tools/`: 100+ tools available to agents
- `src/bun/rpc/`: 40+ RPC handlers for all backend operations
- `src/mainview/components/`: Reusable React UI components
- `src/shared/rpc/`: Type-safe RPC contracts

## 5. Data Model

**Database**: SQLite with Drizzle ORM, WAL mode enabled

### Core Tables (Drizzle-managed)

**settings** - Key-value store for application configuration
- JSON-serialized values for any serializable type
- Categories: general, git, notifications, etc.

**ai_providers** - AI provider credentials and preferences
- Provider type (anthropic, openai, etc.)
- API keys, base URLs, default models
- Validation status, default provider flag

**projects** - Project management
- Name, description, status
- Workspace path, GitHub URL
- Working branch

**agents** - Built-in and user-created agents
- Internal name, display name, color
- System prompt, provider/model overrides
- Temperature, max tokens, enabled status

**agent_tools** - Tool assignments per agent
- Links agents to tools with enable/disable flag
- Tool-specific configuration (JSON)

**conversations** - Chat conversations per project
- Title, pinned/archived flags
- Links to project

**messages** - Individual messages in conversations
- Role (user/assistant/system/tool)
- Agent ID, agent name for sub-agents
- Content, metadata (JSON)

**message_parts** - Structured message components
- Type (text/tool_call/tool_result/reasoning/agent_start/agent_end)
- Tool name, input, output
- Agent name, timestamps
- Sort order for display

**conversation_summaries** - Compacted conversation history
- Links to conversation
- Summary text, token counts

**notes** - Project documentation (markdown)
- Title, content
- Links to project
- DECISIONS.md support

**kanban_tasks** - Kanban board tasks
- Column (backlog/working/review/done)
- Title, description, assigned agent
- Priority, acceptance criteria (JSON)
- Verification status per criterion

**kanban_task_activity** - Activity log for tasks
- Task movement, comments, status changes

**channels** - External channel configurations
- Platform (discord/whatsapp/email)
- Connection details (JSON)
- Project binding

**deploy_environments** - Deployment environments
- Name, type, configuration
- Links to project

**deploy_history** - Deployment records
- Environment, status, timestamps
- Output logs

**prompts** - Saved prompts
- Title, content
- Links to project

**inbox_messages** - Messages from external channels
- Source, sender, content
- Read status, project binding

**cron_jobs** - Scheduled tasks
- Schedule expression, command
- Enabled status

**cron_job_history** - Job execution history
- Job ID, status, timestamps
- Output

**automation_rules** - Event-triggered automation
- Trigger conditions, actions
- Enabled status

**pull_requests** - Pull request tracking
- PR ID, title, status
- Head/sha branches

**pr_comments** - PR comments
- Links to pull request
- Content, timestamps

**webhook_configs** - Webhook configurations
- URL, events, headers
- Links to project

**webhook_events** - Webhook event log
- Event type, payload
- Timestamps

**github_issues** - GitHub issue integration
- Issue ID, title, status
- Links to kanban task

**branch_strategies** - Git branch strategy
- Branch naming patterns
- Merge strategies

**cost_budgets** - Cost tracking per project
- Budget limits, current spend
- Reset period

**audit_log** - Audit trail
- Action, user, timestamp
- Details (JSON)

### Migration History
- v1: Initial schema
- v2: Plugin prompt support
- v3: Agent sessions (later dropped in v4)
- v4: Inline agents (replaced sessions)
- v5: Message parts agent name
- v6: Verification status
- v7: Reviewer tools
- v8: Performance indexes
- v9: MCP config encoding fix
- v10: DB viewer plugin disabled

## 6. Agent System

### Built-in Agent Roster (21 agents)

**Read-only agents** (can run in parallel):
- `code-explorer` - Codebase exploration, dependency mapping
- `research-expert` - Web research, technical investigation
- `task-planner` - Creates plan docs + structured task definitions

**Write agents** (execute sequentially):
- `project-manager` - Orchestrator, talks to humans, runs sub-agents
- `software-architect` - System design and architecture decisions
- `backend-engineer` - Server-side implementation
- `frontend_engineer` - UI implementation
- `database-expert` - DB schema design, query optimization, indexing, migrations
- `api-designer` - REST/GraphQL/gRPC API design, OpenAPI specs
- `mobile-engineer` - React Native, Expo, iOS/Android
- `ml-engineer` - LLM integration, prompt engineering, RAG, vector stores
- `code-reviewer` - Reviews completed work (auto-spawned by review-cycle)
- `qa-engineer` - Runs tests, verifies acceptance criteria
- `devops-engineer` - Deployments, CI/CD, infrastructure
- `documentation-expert` - Documentation generation
- `debugging-specialist` - Root-cause analysis and bug fixing
- `performance-expert` - Profiling and optimization
- `security-expert` - Security review and hardening
- `ui-ux-designer` - Interface and experience design
- `data-engineer` - Data pipelines and storage
- `refactoring-specialist` - Code restructuring and technical debt reduction

### Agent Execution Flow

**Inline Agent Execution**
1. PM calls `run_agent("agent-name", task)` or `run_agents_parallel([...])`
2. Agent gets fresh context: system prompt + task description only
3. Agent executes tool calls (read_file, write_file, git_commit, etc.)
4. Tool calls visible as message parts in chat UI
5. Agent completes and returns summary
6. Handoff summary generated for next agent (if in workflow)

**Sequential Write Agent Enforcement**
- `writeAgentRunning` closure-scoped boolean in PM tools
- Set `true` before `runInlineAgent()`, cleared in `finally`
- Second parallel `run_agent` call returns error
- Read-only agents bypass flag entirely

**Workflow Handoff Summaries**
- Small changes (≤3 files, <200 lines): deterministic summary
- Large changes: AI-generated summary
- Stored in `WorkflowContext.handoffSummaries`
- Prepended to next agent's task as `## Prior Work`

### Tool System (100+ tools)

**File Tools**: read_file, write_file, edit_file, multi_edit, append, delete, move, copy, patch_file, list_directory, directory_tree, search_files, search_content, diff_text, file_info, find_dead_code, is_binary, create_directory, download_file, checksum, batch_rename, file_permissions, archive

**Git Tools**: status, diff, commit, branch, push, pull, fetch, log, pr, stash, reset, cherry_pick

**LSP Tools**: diagnostics, hover, completion, references, rename

**Web Tools**: web_search, web_fetch, http_request, enhanced_web_search

**Shell Tools**: run_shell (with safety guards + approval gate)

**System Tools**: environment_info, sleep

**Kanban Tools**: create/move/update/get/delete tasks, submit_review

**Notes Tools**: create_note, update_note, delete_note

**PM Tools**: run_agent, run_agents_parallel, request_plan_approval, create_tasks_from_plan, set_feature_branch, clear_feature_branch, get_agent_status

**Scheduler Tools**: Cron/scheduler management

**Process Tools**: run_background, check_process, kill_process, list_background_jobs

**Communication Tools**: request_human_input

**Skills Tools**: read_skill, find_skills

**Screenshot Tools**: Screenshot capture

### Context Window Management
- Agent loops track `lastPromptTokens / getContextLimit(modelId)`
- Progressive compaction tiers at 60/70/85/90% context usage
- No iteration cap — agents run until task complete or context truly full
- Anthropic prompt caching for 90% cost reduction on cache hits

## 7. External Integrations

### AI Providers
**Supported Providers**:
- Anthropic (Claude 4.x, 3.x)
- OpenAI (GPT-4o, o3, o4-mini, etc.)
- Google Gemini (Gemini 2.x, 1.5)
- DeepSeek (DeepSeek V3, R1)
- Groq (Llama 3.x, Mixtral)
- xAI Grok (Grok 3)
- OpenRouter (any model via OpenRouter)
- Ollama (locally running models)
- Zhipu AI

### Communication Channels

**Discord**
- discord.js client wrapper (`src/bun/discord/bot.ts`)
- Bot connects to server via token
- Post updates to channel
- Receive commands from users
- Message chunking for long content

**WhatsApp**
- Baileys library (`src/bun/channels/whatsapp-adapter.ts`)
- QR-code pairing
- Bidirectional messaging
- Session persistence via SQLite

**Email**
- IMAP for receiving (`imapflow`)
- SMTP for sending (`nodemailer`)
- Inbox rules for filtering
- Message threading support

### Development Tools

**LSP Integration**
- TypeScript, Python, Go, Rust LSP servers
- Real-time diagnostics, hover, completion
- References, document symbols
- Server lifecycle management
- Auto-installation of LSP servers

**Git Integration**
- Git operations via subprocess
- Branch management, commits, pushes
- Pull request creation and management
- Conflict detection and resolution
- Commit history and diff viewing

**GitHub Integration**
- Issue synchronization
- Pull request management
- Webhook event handling
- Branch strategy configuration
- PAT authentication

### MCP (Model Context Protocol)
- Load external MCP servers
- Expose MCP tools to agents
- Server status monitoring
- Connection management

## Summary

AgentDesk is a sophisticated AI-powered development platform that orchestrates autonomous agent teams through a centralized Project Manager. The platform uses a modern tech stack (Electrobun, React 19, Bun, SQLite) and implements key architectural patterns like inline agent execution, sequential write-agent model, and automatic code review. The system provides comprehensive development tools (LSP, Git, GitHub integration), supports multiple AI providers, and enables external communication via Discord, WhatsApp, and Email. The kanban-based workflow with approval gates ensures human oversight while maximizing autonomous agent productivity.

Key strengths:
- **99% automation**: Humans only approve plans and deployments
- **Safe execution**: Sequential write agents prevent conflicts
- **Visibility**: All tool calls visible in chat
- **Extensible**: Skills system and plugin architecture
- **Production-ready**: Comprehensive testing, audit logging, error handling
