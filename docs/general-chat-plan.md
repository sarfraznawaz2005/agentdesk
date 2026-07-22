# General Chat — Implementation Plan

## Context

Every chat surface in AgentDesk today is either tied to a real project workspace (main project
chat, Quick Chat) or is an ephemeral, single-thread widget (Dashboard PM widget, Collections chat,
Freelance chat, Skills-search chat). There is no ChatGPT-style "ask anything, no project context"
surface. **General Chat** adds a new sidebar nav item, above **Playground**, that opens a
standalone chat page inside the main app window (same chrome as Playground/Agents/etc. — Sidebar
and TopNav stay visible) backed by a brand-new agent, **Assistant**, that:

- Has no knowledge of AgentDesk projects, workspaces, kanban, or any project-scoped feature.
- Cannot dispatch or call other agents — it alone handles every turn, single-agent, no PM.
- Has a fixed, hand-picked tool list (file ops, shell, web, skills, memory, media, system — see
  Subsystem 2), scoped either via normal `agent_tools` rows or `extraTools` injection where the
  tool's normal implementation is project-scoped and needs an Assistant-only equivalent.
- Gets its own DB-persisted, multi-conversation history (new tables, **not** the existing
  `projects`/`conversations`/`messages`).
- Defaults to a fresh OS-temp-dir subfolder per conversation as its workspace.
- Shows live tool-call activity exactly like PM/dashboard widgets (one call at a time, replacing
  the previous one) — but **tool calls are never persisted**; only the final user/assistant text
  of each turn is written to DB, and history replays as plain markdown (tables, code blocks, etc.)
  via the same renderer the main chat already uses for final text.

**Confirmed product decisions (from the user):**
1. Embedded route inside the main `AppShell` (like Playground) — **not** a separate popup
   `BrowserWindow` like Quick Chat.
2. Assistant's memory tools (`save_memory`/`recall_memory`/`delete_memory`) read/write a **new**
   table exclusive to Assistant — **not** PM's existing `global_memories`, and not shared with any
   other agent.
3. Each conversation gets a **fresh** temp-folder workspace (not one shared folder reused across
   conversations).
4. Tool calls during a turn render live (`ToolCallFeed`, one-at-a-time) but are **not** persisted —
   only final text messages build conversation history.
5. No Constitution section in its system prompt, no analytics/prompt-log entries (falls out for
   free — see Subsystem 4).
6. Respects the existing global Streaming setting (Settings → AI → Streaming) and the existing
   MCP servers configured in Settings → AI → MCP Servers, injected directly since Assistant has no
   sub-agents to delegate to.
7. Desktop notification on turn completion, gated by window-focus + the existing
   `session_complete_notification` setting — same mechanism PM already uses.

## UI (General Chat page — closely mirrors Quick Chat's `ChatLayout`, minus project-specific chrome)

- **Show:** conversation sidebar (left), main chat column with markdown-rendered history +
  transient `ToolCallFeed` for the in-flight turn, `ModelSelector`, chat input (shell-style),
  slash-command popover restricted to `/clear`, `/fork`, `/mcp`, `/new`.
- **Replace:** the Build Mode/Plan Mode toggle → a **Deep Research** toggle (off by default,
  persisted per-conversation). When on, Assistant is instructed to ask clarifying questions before
  using the `deep_research` tool, and gets that tool injected for the turn.
- **Omit:** Docs tab, right `ContextPanel` (Files/Docs), "Create Project" button, Focus Mode icon,
  Hide Activity Pane (moot — no activity pane shown here regardless).
- Reuses the main app's Sidebar/TopNav (unlike Quick Chat, which bypasses `AppShell` entirely).

---

## Subsystem 1 — DB / migration (do first)

- **New `src/bun/db/migrations/v61_general-chat.ts`** — mirror the shape of `v57_quick-chat-projects.ts`/`v60_global-memories.ts`: create three new tables (guarded `CREATE TABLE IF NOT EXISTS`).
- **`src/bun/db/schema.ts`** additions, all independent of `projects`:
  - `generalChatConversations` (`general_chat_conversations`): id, title (default "New conversation"), isPinned, isArchived, `deepResearchMode` (int, default 0), createdAt, updatedAt. Shape matches `conversations` minus `projectId`, plus the new toggle column.
  - `generalChatMessages` (`general_chat_messages`): id, conversationId FK → `generalChatConversations.id`, role (`"user"|"assistant"`), content, tokenCount, createdAt. **Flat** — mirrors `freelanceChatMessages` (schema.ts:780-786), not the parts-based `messages`/`messageParts` pair, since tool-call parts are never persisted (decision 4).
  - `generalChatMemories` (`general_chat_memories`): id, title, description, content, recallCount, lastRecalledAt, createdAt, updatedAt. Same shape as `globalMemories` (schema.ts:250-265) but a distinct table exclusive to Assistant (decision 2).
- Register in `src/bun/db/migrate.ts` (import + push into `migrations` array + idempotent `ensureRuntimeSchema()` call), same pattern as every prior version bump.

## Subsystem 2 — Agent + tools

- **`src/bun/db/seed.ts`**: seed a new agent row `assistant` (display name "Assistant"). Hidden the same way `playground-agent`/`issue-fixer` are: `isBuiltin: 1`, `availableToPm: 0`. Give it a `defaultAgentTools` entry (`seed.ts:1384-1435` groups) listing the shared-registry tools from the requested list: `check_process, copy_file, create_directory, delete_file, diff_text, directory_tree, download_file, edit_file, environment_info, file_info, file_permissions, find_skills, generate_image, http_request, is_binary, kill_process, move_file, multi_edit_file, patch_file, read_audio, read_file, read_image, read_skill, read_skill_file, run_shell, search_content, sleep, take_screenshot, validate_skill, web_fetch, web_search, write_file`. `request_human_input` covers the requested `ask_user_question` (no separate tool exists under that name).
- **`src/bun/rpc/agents.ts:31-33`** — add `"assistant"` to the hardcoded name-exclusion list so it's hidden from the Agents page exactly like `playground-agent`/`issue-fixer`/`freelance-expert`.
- **New `src/bun/agents/tools/general-chat-memory.ts`** — implements `save_memory`/`recall_memory`/`delete_memory` bound to `generalChatMemories`. Registered **only** via `extraTools` at the orchestrator's `runInlineAgent` call (Subsystem 4) — never added to the shared `toolRegistry` (`src/bun/agents/tools/index.ts:78-96`), so no other agent can ever get them, and Assistant gets exactly one memory mechanism (decision 2 — no redundant global-memory pair).
- **Todo tools** (`todo_read`/`todo_write`/`todo_update_item`) — currently hardcoded PM-only tools (`pm-tools.ts`/`prompts.ts`). Extract a small standalone, per-conversation-scoped equivalent (in-memory scratch list keyed by `conversationId`, cleared when the conversation's abort/session ends) and inject via the same `extraTools` mechanism.
- **`deep_research`** — inject the real tool (not the registry stub) via `extraTools` only when the conversation's `deepResearchMode` is on, mirroring how Playground overlays its own custom tools (`orchestrator.ts` pattern, `src/bun/agents/tools/playground.ts:200-205`). No change needed to the existing `agentName === "research-expert"` special case in `agent-loop.ts:985`.
- MCP tools: no special wiring needed — `runInlineAgent` already merges MCP tools into any inline agent's tool map generically; Assistant gets them automatically, unlike PM (which only lists server names).

## Subsystem 3 — System prompt

- **New `getAssistantSystemPrompt()` in `src/bun/agents/prompts.ts`**, composed from existing reusable pieces:
  - Date/time + timezone block (reuse `loadUserTimezone()`, `prompts.ts:32`).
  - `buildUserProfileSection()` (`prompts.ts:93`) — name/email, "address the user by name."
  - `buildSkillsDescriptionSection(includeAgentRules=false)` (`prompts.ts:680-726`) — skills list without the agent-routing paragraph (no sub-agents to route to).
  - An MCP section listing connected servers/tools (adapted from `buildPMMcpSection`, `prompts.ts:732`, but since tools are injected directly, this can be short — just context, not a "ask a sub-agent" instruction).
  - A conditional **Deep Research Mode Active** section (same pattern as `PLAN_MODE_SECTION`, `prompts.ts:888`) instructing Assistant to ask clarifying questions before invoking `deep_research`, injected only when the conversation's `deepResearchMode` is true.
  - Explicitly **omit**: Constitution (`loadConstitution`/`filterConstitution`), agents-section, kanban/channel/feature-branch sections, project-context/git-context blocks (no project).

## Subsystem 4 — Backend execution (`src/bun/general-chat/`)

Modeled on **Playground's** use of `runInlineAgent` directly (`src/bun/playground/orchestrator.ts:232-351`) — not Quick Chat's full-PM-engine reuse — since Assistant never dispatches sub-agents and needs none of PM's kanban/plan-approval machinery.

- **New `src/bun/general-chat/paths.ts`** — `getGeneralChatWorkspacePath(conversationId)`: `path.join(os.tmpdir(), "agentdesk-general-chat", conversationId)`, created lazily on first file-writing tool call (mirrors `playground/paths.ts`).
- **New `src/bun/general-chat/orchestrator.ts`**:
  - `sendMessage(conversationId, userText)`: loads prior turns from `generalChatMessages` as `priorMessages`, builds the system prompt (Subsystem 3), calls `runInlineAgent({ agentName: "assistant", persistToDb: false, priorMessages, conversationId, projectContext: { workspacePath: getGeneralChatWorkspacePath(conversationId) }, extraTools: { ...memoryTools, ...todoTools, ...(deepResearchMode ? { deep_research } : {}) }, callbacks: { onPartCreated, onPartUpdated, onPartsRemoved } })`.
  - Callbacks only `broadcastToWebview` live part events (text deltas + tool-call start/end, new event names e.g. `generalChatPart`/`generalChatPartUpdate`) for the transient `ToolCallFeed`/streaming-text UI — **no DB writes per part** (decision 4).
  - Persist the user message row to `generalChatMessages` **before** the agent run starts (so leaving/refreshing the page mid-turn still shows it — a reload reads from the DB, and the live optimistic bubble is thrown away). On turn completion, append the assistant text row, then `broadcastToWebview("generalChatComplete", …)`.
  - Respects `getStreamingMode()` (`src/bun/agents/streaming-mode.ts:22`) with no override (unlike Playground's forced `"full"`).
  - Fires `sendDesktopNotification` on completion, gated by window-focus state + the `session_complete_notification` setting — same logic as `engine-manager.ts`'s existing PM-completion path.
  - Per-`conversationId` `AbortController` registry for stop/regenerate, module-level (mirrors Playground's simpler single-session state, just keyed by conversation instead of global).
  - Because this calls `runInlineAgent` directly rather than routing through `engine.ts`, prompt-logging (`prompt-logger.ts`, only ever called from `engine.ts`) and analytics are skipped automatically — nothing extra to suppress (decision 5).

## Subsystem 5 — RPC

- **New contract `src/shared/rpc/general-chat.ts`**: `listConversations`, `createConversation`, `renameConversation`, `deleteConversation`, `pinConversation`, `archiveConversation`, `forkConversation`, `getMessages(conversationId)`, `sendMessage(conversationId, text)`, `stopGeneration(conversationId)`, `setDeepResearchMode(conversationId, enabled)`.
- **New `src/bun/rpc-groups/general-chat.ts`** implementing the above against Subsystem 1/4.
- Register in `src/bun/rpc-registration.ts` alongside the other rpc-groups.
- Typed callers added to `src/mainview/lib/rpc.ts`.

## Subsystem 6 — Frontend (`src/mainview`)

- **`components/layout/sidebar.tsx`** — insert a new `NavItem` (`{ label: "General Chat", icon: <TBD, distinct from existing icons>, href: "/general-chat" }`) directly above the existing `Playground` entry in `BASE_NAV_ITEMS` (`sidebar.tsx:60-72`).
- **`router.tsx`** — new `generalChatRoute` at `/general-chat` → `GeneralChatPage`, registered as a normal embedded route (no `app-shell.tsx` bypass — decision 1).
- **New `src/mainview/pages/general-chat.tsx`** — structured like `quick-chat.tsx` minus the Docs tab, right pane, and "Create Project" button:
  - Left: `ConversationSidebar` — reuse as-is, but its `projectId: string` prop and internal `rpc.getRunningAgentsForConversation(projectId, id)` call (`conversation-sidebar.tsx:9-21,56-59`) are project-coupled; generalize behind a small adapter (either make `projectId` optional and skip that lookup when absent, or pass a no-op resolver) rather than forking the component.
  - Main column: history renders through the same markdown bubble component the main chat uses for final assistant text (`message-parts.tsx`/`message-bubble.tsx`'s `ReactMarkdown` usage) mapped over the flat `generalChatMessages` array; the in-flight turn renders via the existing `ToolCallFeed` (`tool-call-feed.tsx`, already shows one call at a time by design) and is replaced by the persisted markdown bubble once the turn completes.
  - `ChatInput` — add a `slashCommands?: string[]` (or similar) prop to restrict `SLASH_COMMANDS` (`chat-input-popover.tsx:21-30`) to `/clear`, `/fork`, `/mcp`, `/new` for this surface; `/init`/`/preview` assume a real project workspace and `/compact`/`/info` weren't requested.
  - `ModelSelector` — reused; add a `hideBuildPlanToggle` prop (or equivalent) so General Chat can render a new small `DeepResearchToggle` component in its place, wired to `rpc.setDeepResearchMode`.
- Desktop notification: no new frontend work — window-focus tracking already exists globally in `engine-manager.ts`; Subsystem 4 handles the gating.

## Subsystem 7 — Docs (update in the same change that lands the feature)

- `docs/general-chat-plan.md` (this file).
- `docs/workflow.md` — new "General Chat" section (mirrors the existing Quick Chat section).
- `docs/feature-list.md` — new feature entry.
- `docs/feature-list-short.md` — one new manual-test line.
- `CLAUDE.md` — Built-in Agent Roster (add `assistant` to the hidden/special agents bullet), Repository Layout (`src/bun/general-chat/` subsystem), Agent Orchestration section if warranted.

---

## Ordering & dependencies
1. DB migration v61 + schema (Subsystem 1).
2. Agent seed + hidden-from-Agents-page exclusion + Assistant-only tool modules (Subsystem 2).
3. System prompt builder (Subsystem 3) — depends on 2 for tool/section names.
4. Backend orchestrator (Subsystem 4) — depends on 1-3.
5. RPC contract + handlers + registration + client callers (Subsystem 5) — depends on 4.
6. Frontend route, page, sidebar nav item, shared-component prop additions (Subsystem 6) — depends on 5.
7. Docs updates (Subsystem 7) — last, once the shape of everything above is final.

## Risks
- **`ConversationSidebar`'s `projectId` coupling** — needs a light generalization, not a fork; verify `getRunningAgentsForConversation` behavior when there's no real project/PM engine backing "running" state (General Chat's "running" is just "this conversation's `AbortController` is active").
- **Todo tools extraction** — currently inline/hardcoded for PM; pulling out a standalone per-conversation version needs care not to regress PM's existing behavior.
- **Deep Research toggle enforcement** — per the project's own prior finding that forced `toolChoice` isn't portable across all providers/models, this must be prompt-instruction-based (telling Assistant to use `deep_research` and ask clarifying questions first), **not** a `toolChoice: "required"` hack.
- **Slash-command restriction** — must not regress the main project chat's full `SLASH_COMMANDS` set when adding the new prop.

## Verification (end-to-end)
1. Click "General Chat" in the sidebar → page opens inside the normal AppShell (Sidebar/TopNav visible), empty conversation list, no Docs tab/right pane/Create Project button.
2. Ask a general question unrelated to any project → Assistant answers directly, addresses the user by name at least once, no mention of projects/workspaces/kanban.
3. Ask it to write a file → uses its fresh per-conversation temp folder; confirm the folder path and that a second, unrelated conversation gets a **different** folder.
4. Trigger a multi-tool-call turn → `ToolCallFeed` shows one call at a time, replacing the previous; after completion, reload the conversation → only the final markdown-rendered text persists (tables/code blocks render correctly), no tool-call remnants.
5. Toggle Deep Research on → send a vague research question → Assistant asks a clarifying question before calling `deep_research`; confirm via a temporary log that `deep_research` (not the stub) was actually invoked.
6. `/clear`, `/fork`, `/new`, `/mcp` all work from the popover; `/init`/`/preview`/`/compact`/`/info` are absent from the list.
7. Configure an MCP server in Settings → AI → MCP Servers → its tools are directly callable by Assistant in a turn (no delegation language).
8. Toggle Settings → AI → Streaming between modes → confirm General Chat's response streaming behavior changes accordingly.
9. Minimize/unfocus the window mid-turn → on completion, a desktop notification appears (per the Notifications settings tab); focused window → no notification.
10. Confirm `assistant` never appears on the Agents page and is never offered as a dispatch target anywhere (it has no `run_agent`/`run_agents_parallel` tools and no `agent_tools` rows granting them).
11. Confirm no rows are written to `prompt_log`/analytics tables for General Chat turns.

Run via `.\run.ps1` (Vite + Electrobun) per the visual-testing note; the user restarts the app themselves to test backend changes. Run `bun run typecheck`/`bun run lint` only when explicitly requested, once all subsystems are complete — not mid-build.
