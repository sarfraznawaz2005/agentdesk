---
title: MCP Integration
type: subsystem
status: verified
verified_at: 2026-07-06
sources:
  - src/bun/mcp/client.ts
  - src/bun/rpc/mcp.ts
  - src/bun/agents/agent-loop.ts
  - src/bun/agents/prompts.ts
  - src/bun/index.ts
  - src/bun/db/migrations/v9_fix-mcp-config-encoding.ts
tags: [mcp]
---

# MCP Integration

AgentDesk is an **MCP client** (not a server). It reads a Claude-Desktop-style
`mcpServers` config from the `settings` table, spawns/connects each server,
discovers their tools, and exposes them to **sub-agents only** as AI SDK tools
keyed `{serverName}_{toolName}`. The single most important design point: there is
one in-memory client manager (`src/bun/mcp/client.ts`) that owns all connections
and retries; everything else (RPCs, prompts, the agent loop) just reads from it
via `getMcpTools()` / `getMcpStatus()`.

## Key idea: MCP tools are sub-agent-only

The PM never gets MCP tools. `runInlineAgent` merges `getMcpTools()` into the
sub-agent tool set at `src/bun/agents/agent-loop.ts:887-900`, while the PM engine
(`engine.ts`) does not import them at all. The prompt layer makes this explicit:
the PM prompt only *lists connected server names* and is told to delegate
(`src/bun/agents/prompts.ts:749-757`), whereas sub-agent prompts list the actual
tool keys with "use these directly" (`src/bun/agents/prompts.ts:766-779`). MCP
tools also reach the scheduler task executor (`scheduler/task-executor.ts:316`)
and the freelance chat agent (`rpc/freelance-chat.ts:40`), which run sub-agent-style.

## How it works

### Config storage and the double-encoding trap
Config lives in `settings` under key `mcp_config`, category `mcp`. It is stored
as a **JSON string**, not a parsed object, because `saveSetting()` always
`JSON.stringify`s its argument — so the DB value is double-encoded. Two read
paths handle this differently:
- `rpc/mcp.ts:18` uses `getRawSetting` (not `getSettings`) precisely to avoid the
  generic double-parse, then unwraps one level manually (`rpc/mcp.ts:22-31`).
- `mcp/client.ts:23` uses `getSettings("mcp")` (which parses once) and then
  re-parses only if the value is still a string (`client.ts:31`).

Both accept either the `{ mcpServers: {...} }` Claude-Desktop shape or a flat
`{ name: cfg }` map (`rpc/mcp.ts:37`, `client.ts:32-34`). Migration v9
(`db/migrations/v9_fix-mcp-config-encoding.ts`) repairs legacy rows that were
written as a raw object instead of a double-encoded string — important for
existing users.

### Connection lifecycle
1. Boot: `initMcpClients()` is called from `src/bun/index.ts:307`, **delayed ~10s**
   (`index.ts:303-308`) so spawning external servers (e.g. chrome-devtools launching
   Chrome) doesn't fight the initial UI load.
2. `connectServer` (`client.ts:185`) decides transport by inspecting `cfg.command`:
   an `http(s)://` prefix → remote (`connectRemote`, `client.ts:300`), otherwise a
   local stdio process (`connectLocal`, `client.ts:276`).
   - Remote: tries `StreamableHTTPClientTransport` first, falls back to
     `SSEClientTransport` on failure (`client.ts:302-310`).
   - Local: `StdioClientTransport` with `process.env` merged over `cfg.env`,
     stderr piped to the app log (`client.ts:277-286`).
3. After connect, `client.listTools()` runs and each MCP tool is wrapped as an AI
   SDK `dynamicTool` (`client.ts:209-242`). The wrapper's `execute` simply calls
   `client.callTool(...)`.
4. The entry is stored in the module-level `clients` map with status `connected`
   (`client.ts:244`).

### Tool naming and schema massaging
Each tool key is `sanitize(serverName)_sanitize(toolName)` where `sanitize`
replaces non-`[A-Za-z0-9_-]` chars with `_` (`client.ts:183`, `:214`). The MCP
`inputSchema` is coerced into a strict object schema with
`additionalProperties: false` (`client.ts:217-222`) for provider compatibility.
One hard-coded special case: `take_screenshot` calls are forced to
`fullPage:false, format:"jpeg", quality:80` regardless of agent args
(`client.ts:232-234`) because full-page PNGs blow past provider image size limits.

### Resilience
- On any connect failure the entry is marked `failed` and `scheduleRetry` runs
  exponential backoff (5s,10s,20s,40s,80s) up to `MAX_RETRIES=5`
  (`client.ts:259-274`, constants `:56-57`).
- A local transport that closes unexpectedly while `connected` flips to `failed`
  and triggers a fresh retry (`client.ts:289-295`).
- `reconnectMcpServer(name?)` reconnects one server or all `failed` ones;
  `disconnectMcpServer(name)` sets a server to `disabled` and cancels retries
  (`client.ts:107-158`).

### RPC and settings UI
`rpc/mcp.ts` exposes `getMcpConfig`, `saveMcpConfig`, `getMcpStatusRpc`,
`reconnectMcpServerRpc`, `disconnectMcpServerRpc`. `saveMcpConfig` validates JSON,
persists, then fire-and-forget calls `reloadMcpClients()` (`rpc/mcp.ts:63-75`).
These are wired into the RPC surface via `rpc-groups/plugins-tools.ts:44-48`,
contracts in `shared/rpc/system.ts:111-134`, client in `lib/rpc.ts:1155-1159`. The
config editor + live status badges live in `pages/settings/mcp.tsx` and a quick
status/reconnect control sits in `components/chat/chat-input.tsx:671-745` (state
at `:217-221`).

### Stuck-loop guardrail (MCP-specific)
The agent loop's repeated-identical-call detector applies **only** to MCP tools
(`agent-loop.ts:889-890`, `:1240-1260`): `mcpToolNames` gates the check because
built-in tools are cheap to repeat, while a wedged browser/automation MCP tool
spinning on the same args is the real failure mode. Threshold warn then abort
with `stopReason="stuck_loop"`.

## Key files
| File | Role |
|---|---|
| `src/bun/mcp/client.ts` | The whole client manager: load config, connect (stdio/http/sse), list+wrap tools, retry, expose `getMcpTools`/`getMcpStatus` |
| `src/bun/rpc/mcp.ts` | RPC handlers for config read/save + status/reconnect/disconnect |
| `src/bun/agents/agent-loop.ts` | Merges MCP tools into sub-agent tools; MCP-only stuck-loop guard |
| `src/bun/agents/prompts.ts` | PM "delegate" section vs sub-agent "use directly" section; chrome-devtools vs live-browser guidance |
| `src/bun/index.ts` | Delayed `initMcpClients()` at boot |
| `src/bun/db/migrations/v9_fix-mcp-config-encoding.ts` | Repairs legacy mis-encoded `mcp_config` rows |
| `src/mainview/pages/settings/mcp.tsx` | Config editor + per-server status UI |

## Gotchas / Constraints
- **`mcp_config` is a double-encoded JSON string.** Read it via `getRawSetting`
  (as `rpc/mcp.ts` does) — using `getSettings` then forgetting it may still be a
  string (handled in `client.ts:31`) bites callers who assume an object.
- **PM cannot call MCP tools** — by design. If a user asks the PM to "use the
  chrome-devtools MCP", the PM must dispatch a sub-agent; MCP tools are only in
  the sub-agent tool map.
- **`connectServer` writes a throwaway `connecting` client then a second real
  `client`** (`client.ts:192` vs `:199`) — the connecting placeholder is replaced
  on success; only the second instance is actually connected.
- **`take_screenshot` args are silently overridden** to a small JPEG; agents
  cannot force a full-page PNG.
- **Remote detection is purely string-prefix** on `command`; a non-URL command is
  always treated as a local stdio spawn.
- **Init is delayed 10s** — MCP tools are unavailable in the first seconds after
  launch; this is intentional, not a bug.
- A failed server retries at most 5 times then "gives up" (`client.ts:260-262`);
  recovery after that requires a manual reconnect or a config save.

## Related
- [[agent-engine]]
- [[plugins]]
- [[skills]]

## Open questions
- Remote (HTTP/SSE) MCP servers have no auth header handling visible in
  `connectRemote` — unclear how authenticated remote MCP endpoints are intended
  to be configured.
- No explicit unexpected-close handler for remote transports (only stdio has
  `transport.onclose` at `client.ts:289`); remote drop recovery may rely solely
  on the next manual reconnect.
