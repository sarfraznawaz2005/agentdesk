---
name: agentdesk-guide
description: AgentDesk codebase conventions, architecture patterns, and development guidelines. Use when working on or understanding the AgentDesk application itself.
agent: backend-engineer
allowed-tools: read_file, search_files, search_content, directory_tree
---

# AgentDesk Development Guide

## Tech Stack

- **Desktop**: Electrobun (Bun + native WebView2) — NOT Electron
- **Frontend**: React 19, TanStack Router, Zustand, Tailwind CSS, Radix UI
- **Backend**: Bun (TypeScript), Drizzle ORM, SQLite (WAL mode)
- **AI**: Vercel AI SDK (`ai` ^6.0) — provider-agnostic (Anthropic, OpenAI, OpenRouter, Ollama, Google Gemini, DeepSeek, Groq, xAI Grok)

## Key Architecture Patterns

### RPC Pattern (Frontend ↔ Backend)
All communication goes through Electrobun's typed RPC:
1. Define contract in `src/shared/rpc/<domain>.ts`
2. Implement handler in `src/bun/rpc/<domain>.ts`
3. Register in `src/bun/rpc-registration.ts`
4. Call from frontend via `src/mainview/lib/rpc.ts`

### Agent System
- **AgentEngine** (`src/bun/agents/engine.ts`) — PM streaming + inline sub-agent execution
- **PM is the sole orchestrator** — there is no separate WorkflowEngine state machine. The PM handles planning, approval, task creation, and agent dispatch directly.
- **Inline sub-agents** run in the main conversation via `run_agent` / `run_agents_parallel` — their tool calls are visible as message parts in chat
- **Kanban tasks** created ONLY after plan approval (via `create_tasks_from_plan`)

### Database
- Schema: `src/bun/db/schema.ts` (single source of truth)
- Migrations: `src/bun/db/migrations/` (new file per schema change)
- Agent definitions/prompts: `src/bun/db/seed.ts`

## Code Conventions

- Use `import { Utils } from "electrobun/bun"` for paths, NOT Node.js equivalents
- Prefer Drizzle query builder over raw SQL
- All agent tools return JSON strings
- Tool categories: file, shell, communication, notes, kanban, git, web, system, process, plugin, coordination, skills
- System prompts live in `src/bun/db/seed.ts`, not inline in engine code
