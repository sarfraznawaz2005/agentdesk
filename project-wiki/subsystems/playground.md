---
title: Playground
type: subsystem
status: verified
verified_at: 2026-06-27
sources:
  - src/bun/playground/orchestrator.ts
  - src/bun/playground/server.ts
  - src/bun/playground/paths.ts
  - src/bun/agents/tools/playground.ts
  - src/bun/agents/agent-loop.ts
  - src/bun/rpc/playground.ts
  - src/bun/db/seed.ts
tags: [playground, artifacts]
---

# Playground

An Artifacts-style **live-preview builder**. A single dedicated agent
(`playground-agent`, display name "Playground Agent") takes a free-form prompt,
builds a web-renderable artifact into an **OS-temp folder**, and renders it live
in an in-page `<iframe>`. It is deliberately **decoupled from the PM / kanban /
review pipeline**: no orchestrator dispatch, no DB conversation rows, no task
flow. The whole feature is a thin shell around the *existing* inline-agent
executor (`runInlineAgent`) plus three new options it was given specifically for
this use case.

## Key idea — three reused-executor hooks

The Playground does **not** fork `agent-loop.ts`. Instead `runInlineAgent` grew
three options (`src/bun/agents/agent-loop.ts:165`, `:171`, `:176`, plus
`excludeTools` `:181`) so the same loop can serve an ephemeral, JSON-backed,
extra-tooled run:

- **`priorMessages`** — prior turns prepended before the current task
  (`agent-loop.ts:1055`). The Playground keeps its history in a temp JSON file,
  not the DB, and threads it here. Note: once rule-based compaction fires
  (>70% context) these fold into a summary.
- **`persistToDb: false`** — skip ALL `messages` / `message_parts` /
  `conversations` writes (`agent-loop.ts:791`). Callbacks still fire to drive the
  UI; this is why the Playground produces zero orphan DB rows for its throwaway
  conversation.
- **`extraTools`** — merged *last* so they override built-ins
  (`agent-loop.ts:883`). The Playground injects its preview/reject tools plus an
  auto-approved `run_shell`.
- **`excludeTools`** (supports trailing-`*` prefix matching,
  `agent-loop.ts:948`) — removes tools that would dead-lock with no UI to satisfy
  them: `request_human_input`, `chrome-devtools_*`, `verify_implementation`
  (`orchestrator.ts:322`).

## How it works

```mermaid
sequenceDiagram
  participant UI as Playground page
  participant RPC as rpc/playground.ts
  participant Orc as orchestrator.ts
  participant Loop as runInlineAgent
  participant Tools as playground tools
  participant Srv as server.ts (4760+)
  UI->>RPC: playgroundSend(message, consoleErrors)
  RPC->>Orc: runPlayground (fire-and-forget)
  Orc->>Loop: runInlineAgent(persistToDb:false, priorMessages, extraTools)
  Loop-->>Orc: onPartCreated / onPartUpdated callbacks
  Orc-->>UI: broadcast agentdesk:playground-* (live activity log)
  Loop->>Tools: playground_render_preview(static|file|devserver)
  Tools->>Srv: (static/file) URL on 127.0.0.1:PORT
  Tools-->>UI: broadcast playgroundPreviewReady (swap to iframe)
  Srv-->>UI: iframe loads artifact + console-capture shim
```

1. **Send.** `playgroundSend` (`rpc/playground.ts:28`) rejects if a run is
   already active, then fire-and-forgets `runPlayground` — it does **not** await,
   so the UI updates purely from broadcasts. Any `consoleErrors` the live preview
   captured are appended to the task so the agent can fix real runtime errors,
   but the *saved* history keeps only the clean user message
   (`orchestrator.ts:235-241`).
2. **Run setup.** `runPlayground` (`orchestrator.ts:228`) resolves the default
   provider (`resolveProviderConfig`, `:90`), loads prior turns from
   `conversation.json`, builds a **workspace-context block** (absolute temp path
   + top-level file listing) injected into the system prompt every turn
   (`buildWorkspaceContext`, `:132`), and assembles `extraTools` =
   `createPlaygroundTools()` + the auto-approved `run_shell` (`:265`).
3. **Execute.** `runInlineAgent` runs with `workspacePath = PLAYGROUND_FILES_DIR`
   and `projectId = "playground"` (`orchestrator.ts:305`). The agent-loop's
   cwd-wrapper scopes `run_shell` and the directory tools to that folder
   (`agent-loop.ts:907`), so even the auto-approved shell can't escape the
   sandbox. Activity streams via `agentdesk:playground-*` broadcasts mirrored
   into an in-memory `activityParts` buffer so navigating away and back restores
   the log within a session (`orchestrator.ts:201`, `bufferPart` `:167`).
4. **Render.** When the artifact is ready the agent calls
   `playground_render_preview` (`tools/playground.ts:66`) with one of three
   kinds:
   - **`static`** — self-contained files → URL on the static server
     (`staticUrl`, `:61`).
   - **`file`** — a single document (PDF/image/markdown/csv); PDFs are routed
     through the `/__pdf` PDF.js viewer; Office and server-side scripts are
     **rejected with guidance** because the browser can't render them
     (`tools/playground.ts:106-126`).
   - **`devserver`** — an interactive app the agent started itself via
     `run_background` (Vite/Next/Python). The tool polls `waitReachable` (20 s)
     before showing it (`:96`).
   It writes `preview.json` and broadcasts `playgroundPreviewReady`; the page
   swaps from the activity log to the iframe.
5. **Thread.** After the run, the user message + the agent's `result.summary`
   are pushed to `conversation.json` (capped at `MAX_HISTORY_TURNS = 30`,
   `orchestrator.ts:37`) for the next turn's `priorMessages`.

## Temp-folder layout

Everything lives under `{os.tmpdir()}/agentdesk-playground/`
(`paths.ts:19`): `files/` is the agent workspace (cwd, shell sandbox root,
static web root, and what gets copied on "Create Project"); `.playground/` holds
metadata that is **never** copied into a created project —
`conversation.json`, `preview.json`, `deploy.json`, and `servers.json`. There is
a **single active playground** (no per-session subfolders); "New Playground"
wipes the whole root and recreates the empty structure (`wipePlayground`,
`paths.ts:41`, with Windows `EBUSY`/`EPERM` retries). When even the retries lose
to a dev server still holding a file, the `newPlayground` RPC returns
`{ ok:false, error }` (rather than throwing) and the page shows a **"Stop servers
& retry"** toast action that re-calls `newPlayground({ force:true })` — which
kills every running job under the playground root (`getRunningJobsUnderPath` +
`killJobById`) to release the locks before wiping (`rpc/playground.ts:45`). The
New Playground confirm dialog also surfaces the running dev-server count up front,
so the user knows what will be stopped before the wipe runs.

## Static preview server + console capture

`server.ts` is a `Bun.serve` static server bound to the first free port in
`[4760..4764]` (`server.ts:193`). Two notable behaviours:

- **Console capture shim.** Every served HTML response is rewritten to inject a
  script that tees `console.error`/`warn`, `window.onerror`, and
  `unhandledrejection` back to the host page via `postMessage`
  (`CONSOLE_CAPTURE_SCRIPT`, `server.ts:52`; `injectConsoleCapture`, `:67`). The
  page collects these into `store.consoleErrors` and feeds them back on the next
  `playgroundSend` so the agent can self-correct. It explicitly **filters
  Electrobun's own webview-bridge RPC noise** (`0x80070490` / "Element not
  found") which fires in every document including the preview iframe
  (`server.ts:61-64`).
- **SPA fallback.** Extension-less, not-found paths fall back to the root
  `index.html` so client-side routers work inside the preview
  (`server.ts:164`).
- **File watcher.** A debounced (400 ms) recursive `fs.watch` on `files/`
  broadcasts `playgroundFilesChanged` so the iframe auto-reloads after follow-up
  edits (`startPlaygroundFileWatcher`, `server.ts:234`). The watcher must be
  *stopped before* wiping the dir and *restarted after* (`orchestrator.ts:358`),
  or Windows holds the directory handle.

## Dev-server persistence (survive-restart)

Dev servers the agent starts are tracked in `servers.json`
(`paths.ts:26`). `getPlaygroundDevServers` (`rpc/playground.ts:356`) merges
currently-running background jobs under the playground root into the persisted
set, so after an app restart — which kills those processes — they reappear in the
toolbar "Servers" strip as **stopped** with a ▶ button.
`startPlaygroundDevServer` (`:387`) re-runs a persisted command via the shared
`startBackgroundJob` from `process.ts`; `stopPlaygroundDevServer` (`:381`) kills
the process but **keeps** the entry (only "New Playground" clears the file via
`killJobsUnderPath`, `orchestrator.ts:353`).

## Promote / export

`createProjectFromPlayground` (`rpc/playground.ts:144`) AI-names the project from
its file list, creates it via the normal `createProjectHandler`, and `cpSync`s
`files/` into the new workspace (filtering `PLAYGROUND_COPY_IGNORE`).
`exportPlaygroundZip` (`:237`) and `deployPlayground` (surge.sh, `:502`) are the
other exits.

## Key files

| File | Role |
|---|---|
| `src/bun/playground/orchestrator.ts` | Run lifecycle: provider resolve, prior-message threading, `extraTools`, activity buffer, wipe/shutdown |
| `src/bun/playground/server.ts` | Static preview server (4760+), console-capture shim, PDF.js route, SPA fallback, file watcher |
| `src/bun/playground/paths.ts` | Temp-folder layout + `wipePlayground` / `hasPlaygroundFiles` |
| `src/bun/agents/tools/playground.ts` | `playground_render_preview` / `playground_reject` (injected via `extraTools`, never in the global registry) |
| `src/bun/rpc/playground.ts` | RPCs: send/stop/new/state/source, create-project, export-zip, dev-server list/start/stop, surge deploy |
| `src/bun/agents/agent-loop.ts` | The reused executor — `priorMessages` / `persistToDb` / `extraTools` / `excludeTools` options |
| `src/bun/db/seed.ts` | `playground-agent` row + system prompt (`:1107`) + its tool list (`:1386`) |
| `src/mainview/pages/playground.tsx` | The page: live log, iframe, console panel, servers strip |

## Gotchas / Constraints

- **The "zero `agent_tools` rows ⇒ full registry" claim is WRONG for this
  agent.** `CLAUDE.md` and the agent roster say `playground-agent` has no
  `agent_tools` rows so `getToolsForAgent` returns the whole registry. In
  reality `seed.ts:1386` seeds it a **focused ~37-tool set**
  (`FILE_READ`+`FILE_WRITE`+`download_file`+`SHELL`+`WEB`+`LSP`+`PROCESS`+`sleep`+`SKILLS`
  — no git/kanban/notes/planning). `getToolsForAgent` only returns the full set
  when an agent truly has zero rows (`tools/index.ts:147`,`:169`), which is not
  the case here. The "all tools" experience comes from `extraTools` + the lack
  of role filtering, not from an empty tool config. Treat the roster note as
  stale.
- **`run_shell` is auto-approved here** (`autoApprovedShellTool`,
  `orchestrator.ts:267`) — no approval gate. Safety comes only from the
  agent-loop cwd-wrapper scoping it to `files/`; do not assume the normal shell
  approval guardrails apply.
- **`request_human_input` is removed**, and `playground-agent` is in
  `NO_HUMAN_INPUT_AGENTS` (`seed.ts:1397`): it must never raise a blocking
  dialog. It escalates by *rejecting* (`playground_reject`) instead.
- **chrome-devtools_* MCP tools are excluded on purpose** — they attach to a
  separate external browser and can't see the in-app preview
  (`orchestrator.ts:319-322`).
- **Single global playground.** `running` is a module-level boolean
  (`orchestrator.ts:44`); a second `playgroundSend` is rejected. There is one
  shared temp folder for the whole app, not one per project.
- **Legacy name `general-agent`.** The agent was renamed from `general-agent`
  (collided with users' custom agents); migration v26 deletes the old row on
  upgrade (`seed.ts:1549`).
- **`persistToDb:false` means callbacks ARE the persistence.** All UI state and
  the JSON history come from callbacks; if a callback path breaks, nothing is
  recoverable from the DB.

## Related

- [[agent-engine]] — the PM/kanban/review path the Playground deliberately bypasses
- [[rpc-layer]] — how `rpc/playground.ts` is wired to the frontend
- [[providers]] — `resolveProviderConfig` picks the default provider/model

## Open questions

- Linux `fs.watch` recursive support is partial; the page relies on manual
  Refresh there. Unverified how often that degrades in practice.
- `deployPlayground` hardcodes a shared surge.sh fixed password
  (`rpc/playground.ts:399`) for new-account creation — unclear how this behaves
  if many users share the same generated subdomain namespace.
