# AgentDesk

A cross-platform desktop application where autonomous AI agent teams handle the full software development lifecycle — planning, coding, reviewing, and testing — while humans approve plans and deployments only.

**Motto: 99% agent-driven. Humans approve, deploy, and communicate.**

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running](#running)
- [Building](#building)
- [How It Works](#how-it-works)
- [Agent Roster](#agent-roster)
- [AI Providers](#ai-providers)
- [External Channels](#external-channels)
- [Skills System](#skills-system)
- [Project Structure](#project-structure)
- [Database](#database)
- [Dev Commands](#dev-commands)
- [Documentation](#documentation)

---

## Overview

AgentDesk manages software development projects through a team of specialized AI agents orchestrated by a Project Manager (PM) agent. The PM talks to the user, creates plans, spawns sub-agents, and manages a kanban board. Write agents (backend engineer, frontend engineer, etc.) execute one at a time; read-only agents can run in parallel.

**Core workflow:**

1. User describes a task in chat
2. PM creates a plan → user approves
3. PM creates kanban tasks and dispatches specialist agents
4. Agents write code, commit to a feature branch, move tasks through the board
5. Code reviewer auto-spawns when a task reaches the "review" column
6. Completed work is summarized back to the user

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | [Electrobun](https://electrobun.dev) 1.16.0 (Bun runtime + native WebView2) |
| Frontend | React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI |
| Backend | Bun (TypeScript), Drizzle ORM |
| Database | SQLite (WAL mode) |
| AI SDK | Vercel AI SDK (`ai` ^6.0) — provider-agnostic |
| Build | Vite (frontend) + Electrobun build (app bundle) |

---

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager
- Windows 11 (WebView2 is included) or macOS / Linux with compatible WebView
- At least one AI provider API key (Anthropic, OpenAI, OpenRouter, etc.)
- Git (for agent git operations)

---

## Installation

### Prebuilt release (Windows)

1. Click **Start**, type `PowerShell`, and open **Windows PowerShell**.
2. Paste the command below and press **Enter**:
   ```powershell
   irm https://raw.githubusercontent.com/sarfraznawaz2005/agentdesk/main/install.ps1 | iex
   ```
3. The script downloads the latest AgentDesk Setup build and launches the installer — follow
   the on-screen installer steps as normal.

AgentDesk isn't code-signed yet, so a browser-downloaded copy of the installer will trigger a
Windows SmartScreen warning ("unrecognized publisher") — running it this way via PowerShell
avoids that prompt. You can still download the Setup/portable zip directly from the
[Releases page](https://github.com/sarfraznawaz2005/agentdesk/releases/latest) if you prefer;
you'll just see SmartScreen on first run.

### From source

```bash
git clone <repo-url>
cd agentdesk
bun install
```

---

## Running

**Development (recommended):**
```bash
bun run dev
```
Starts Electrobun in watch mode with Vite production build. Rebuilds on file changes.

**HMR mode (faster iteration on frontend):**
```bash
bun run dev:fast
```
Runs Vite dev server on port 5173 alongside Electrobun. Frontend hot-reloads without full rebuild.

**Windows — use the PowerShell launcher** (sets required env vars including WebView2 remote debugging port):
```powershell
.\run.ps1
```

> `run.ps1` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` which enables CDP-based browser testing via the chrome-devtools MCP.

---

## Building

```bash
bun run build
```

Produces a distributable app bundle in `build/`.

```bash
bun run build:canary
```

Canary build variant.

---

## How It Works

### Agent Execution

- The **Project Manager** is the sole orchestrator. It handles planning, task creation, and dispatching sub-agents.
- Sub-agents run **inline** in the main conversation — their tool calls are visible as message cards in the chat.
- **One write-agent at a time**: a `writeAgentRunning` boolean guard in PM tools prevents concurrent write operations.
- **Read-only agents** (`code-explorer`, `research-expert`, `task-planner`) can run in parallel via `run_agents_parallel`.

### Plan → Approve → Execute

1. PM calls `request_plan_approval` → plan card shown in chat
2. User replies "approve"
3. PM calls `create_tasks_from_plan` → kanban tasks created
4. PM calls `run_agent` to dispatch specialist agents one at a time

### Kanban Flow

```
backlog → working → review → done
```

- `backlog`: created by PM via `create_tasks_from_plan`
- `working`: agent claims task via `move_task`
- `review`: agent finishes and moves task; code-reviewer auto-spawns
- `done`: review-cycle moves task after `submit_review(approved)`

### Inline Agent Execution

Sub-agents run **inline** in the main conversation with fresh context per invocation. Each agent receives only its system prompt and task description — no persistent session memory. This stateless model proved simpler and more reliable than the earlier session-based approach.

### Feature Branch Workflow

PM calls `set_feature_branch` before dispatching write agents. Agents commit to this branch; the PM can create a pull request when the feature is complete.

### Context Window Management

Agent loops track context usage (`lastPromptTokens / getContextLimit(modelId)`). Progressive compaction kicks in at 60/70/85/90% usage. Agents run until the task is complete — there is no iteration cap.

---

## Agent Roster

| Agent | Role | Parallel? |
|---|---|---|
| `project-manager` | Orchestrator — talks to users, dispatches agents | — |
| `task-planner` | Creates plan docs and task definitions | Read-only |
| `code-explorer` | Codebase exploration, dependency mapping | Read-only |
| `research-expert` | Web research, technical investigation | Read-only |
| `software-architect` | System design decisions | No |
| `backend-engineer` | Server-side implementation | No |
| `frontend_engineer` | UI implementation | No |
| `database-expert` | Schema design, queries, migrations | No |
| `api-designer` | REST/GraphQL/gRPC API design | No |
| `mobile-engineer` | React Native / iOS / Android | No |
| `ml-engineer` | LLM integration, RAG, vector stores | No |
| `code-reviewer` | Code review (auto-spawned by review-cycle) | No |
| `qa-engineer` | Test execution, acceptance criteria | No |
| `devops-engineer` | Deployments, CI/CD, infrastructure | No |
| `documentation-expert` | Documentation generation | No |
| `debugging-specialist` | Root-cause analysis, bug fixing | No |
| `performance-expert` | Profiling and optimization | No |
| `security-expert` | Security review and hardening | No |
| `ui-ux-designer` | Interface and experience design | No |
| `data-engineer` | Data pipelines and storage | No |
| `refactoring-specialist` | Code restructuring, tech debt | No |

---

## AI Providers

Supported out of the box (configure API keys in Settings › Providers):

| Provider | Models |
|---|---|
| Anthropic | Claude 4.x, Claude 3.x |
| OpenAI | GPT-4o, o3, o4-mini, etc. |
| Google Gemini | Gemini 2.x, 1.5 |
| DeepSeek | DeepSeek V3, R1 |
| Groq | Llama 3.x, Mixtral |
| xAI Grok | Grok 3 |
| OpenRouter | Any model via OpenRouter |
| Ollama | Any locally running model |

---

## External Channels

Agents and users can communicate via:

- **Discord** — bot connects to a server; agents can post updates and receive commands
- **WhatsApp** — via Baileys library; QR-code pairing
- **Email** — IMAP (receive) + SMTP (send) via nodemailer

Configure under Settings › Channels.

---

## Skills System

Skills extend what agents can do. A skill is a directory containing a `SKILL.md` file with YAML frontmatter and markdown instructions.

Skills are **filesystem-only** — never stored in the database. Two locations:

- **Built-in**: `skills/` in the project root (copied into app bundle)
- **User**: `{userData}/skills/` — editable outside the app

Skills are compatible with the Claude Code / Agent Skills open standard.

```
skills/
└── my-skill/
    └── SKILL.md    # frontmatter (name, description, allowed-tools) + instructions
```

Agents see a compact listing (name + description) in their system prompt and load full content on demand via `read_skill`. See `docs/skills.md` for the full specification.

---

## Project Structure

```
src/
├── bun/                  # Bun backend (main process)
│   ├── agents/           # Agent engine, PM tools, sub-agent executor, review cycle
│   │   └── tools/        # All agent tool implementations
│   ├── db/               # Drizzle schema, migrations, seed data
│   ├── rpc/              # RPC handlers (one file per domain)
│   ├── channels/         # Discord, WhatsApp, Email adapters
│   ├── providers/        # AI provider adapters + model catalogue
│   ├── scheduler/        # Cron jobs + automation engine
│   ├── skills/           # Skill loader and registry
│   └── plugins/          # Plugin system + LSP server management
│
├── mainview/             # React frontend (rendered in Electrobun webview)
│   ├── pages/            # Route pages (dashboard, project, settings, inbox, etc.)
│   ├── components/       # UI components (chat, kanban, git, deploy, etc.)
│   ├── stores/           # Zustand state stores
│   └── lib/              # RPC client, utilities
│
└── shared/               # Types shared between Bun and frontend
    └── rpc/              # RPC contract definitions (source of truth for API shape)
```

---

## Database

SQLite database in WAL mode, managed by Drizzle ORM. Key tables:

`projects` · `conversations` · `messages` · `message_parts` · `kanban_tasks` · `agents` · `settings` · `notes` · `channels` · `pull_requests` · `github_issues` · `webhook_configs` · `webhook_events` · `cron_jobs` · `automation_rules` · `audit_log`

> Note: Agent sessions tables (`agent_sessions`, `agent_session_messages`) and `agent_task_results` were created in v3 but dropped in v4 when the inline agent model replaced persistent agent sessions. See `docs/agent-sessions-proposal.md` for the historical design.

**Schema changes require a new migration file** in `src/bun/db/migrations/`. Never edit `schema.ts` without adding the corresponding migration.

---

## Dev Commands

```bash
bun run dev          # Dev mode (Vite build + Electrobun watch)
bun run dev:fast     # HMR mode (Vite dev server + Electrobun)
bun run build        # Production build
bun run build:canary # Canary build variant
bun run typecheck    # TypeScript check (no emit)
bun run lint         # ESLint
bun run lint:fix     # ESLint with auto-fix
bun run format       # Prettier
bun run format:check # Prettier check
bun run db:generate  # Generate Drizzle migrations from schema changes
bun run db:migrate   # Run Drizzle migrations
bun run db:studio    # Open Drizzle Studio (DB browser)
```

---

## Documentation

| File | Contents |
|---|---|
| `CLAUDE.md` | Codebase map for AI agents — repo layout, agent roster, RPC pattern, critical rules |
| `docs/workflow.md` | Execution flow — PM tools, kanban, review cycle, key files |
| `docs/skills.md` | Skills system specification |
| `docs/sequential-agent-model.md` | Sequential write-agent enforcement design |
| `docs/agent-sessions-proposal.md` | Agent session persistence design (implemented) |
| `docs/BROWSER-TESTING.md` | WebView2 remote debugging and CDP testing guide |
