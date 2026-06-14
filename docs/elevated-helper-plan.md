# Elevated Helper Process — Implementation Plan

> ⚠️ **STATUS: NOT BUILT (as of 2026-06).** No elevated helper exists in the codebase —
> no `src/bun/elevated/`, no `helper/` project, no `elevated_exec`/`schedule_os_task` tool.
> This is a forward-looking design only; implement when a concrete elevated OS operation is needed.
> Scope: Windows only (macOS/Linux use polkit/sudo — separate plan if needed).

---

## Overview

A small companion executable (`agentdesk-helper.exe`) is bundled with the app and launched on demand with UAC elevation. The main Bun process communicates with it over a local named pipe. Agents call a new `elevated_exec` tool (or operation-specific tools like `schedule_os_task`) which routes through the helper. Every elevated operation requires human approval via the existing shell approval gate before the request is sent.

```
User message
    ↓
AgentEngine (Bun)
    ↓
elevated_exec tool (src/bun/agents/tools/elevated.ts)
    ↓  [human approval gate — always required]
ElevatedBridge (src/bun/elevated/bridge.ts)
    ↓  [named pipe: \\.\pipe\agentdesk-elevated-{sessionId}]
agentdesk-helper.exe  (runs as Administrator)
    ↓
OS API (Task Scheduler COM, SCM, Registry HKLM, etc.)
    ↓
Result JSON back through pipe → agent tool result
```

---

## Repository Layout (new files)

```
src/
├── bun/
│   ├── elevated/
│   │   ├── bridge.ts          # Manages helper lifecycle + named pipe client
│   │   ├── protocol.ts        # Shared request/response types (IPC contract)
│   │   └── operations/        # One file per operation category
│   │       ├── task-scheduler.ts   # Windows Task Scheduler wrappers
│   │       ├── services.ts         # Windows Service Control Manager
│   │       ├── registry.ts         # HKLM registry read/write
│   │       ├── firewall.ts         # Windows Firewall rules
│   │       └── index.ts            # Operation registry + dispatcher
│   └── agents/tools/
│       └── elevated.ts        # Agent-facing tool definitions
│
helper/                        # Separate Bun project — compiled to exe
├── src/
│   ├── main.ts                # Entry point — pipe server + dispatcher
│   ├── protocol.ts            # Shared with bridge.ts (symlinked or copied at build)
│   ├── operations/
│   │   ├── task-scheduler.ts
│   │   ├── services.ts
│   │   ├── registry.ts
│   │   └── firewall.ts
│   ├── validator.ts           # Whitelist enforcement — rejects unknown ops
│   └── audit.ts               # Logs every operation to a helper-side audit file
├── package.json
└── build.ts                   # Bun.build() → helper/dist/agentdesk-helper.exe
```

The helper is a **completely separate Bun project**. It has no dependency on the main app — only on the shared protocol types. This keeps the attack surface minimal.

---

## IPC Protocol

All messages are newline-delimited JSON over the named pipe.

### Request (main → helper)

```typescript
interface ElevatedRequest {
  id: string;               // UUID — correlates response to request
  operation: string;        // e.g. "task_scheduler.create"
  params: Record<string, unknown>;
  callerAgentId: string;    // for audit log
  approvalToken: string;    // opaque token issued by approval gate; helper verifies it
}
```

### Response (helper → main)

```typescript
interface ElevatedResponse {
  id: string;               // matches request id
  success: boolean;
  result?: unknown;         // operation-specific output
  error?: string;
  errorCode?: string;       // e.g. "ACCESS_DENIED", "INVALID_PARAMS", "NOT_WHITELISTED"
}
```

### Pipe name

```
\\.\pipe\agentdesk-elevated-{sessionId}
```

`sessionId` is a random UUID generated at app startup and passed to the helper as a CLI argument. This prevents pipe hijacking by other processes — both sides must know the session ID.

---

## Helper Executable (`helper/src/main.ts`)

### Startup sequence

1. Read `sessionId` from `process.argv[2]`
2. Verify the pipe name matches — refuse connections that don't present the correct session
3. Create named pipe server: `\\.\pipe\agentdesk-elevated-{sessionId}`
4. Write `READY\n` to stdout so the bridge knows the helper is up
5. Process requests from the pipe in a loop

### Security controls in the helper

- **Operation whitelist**: `validator.ts` maintains a hard-coded `Set<string>` of allowed operation names. Any request with an unknown operation is rejected with `NOT_WHITELISTED` — no eval, no arbitrary shell execution.
- **Approval token verification**: The helper checks the `approvalToken` field against a shared secret derived from the session ID + a HMAC key exchanged at startup. Prevents a rogue process from sending requests directly to the pipe.
- **Parameter schema validation**: Each operation handler defines a Zod schema. Requests that fail validation are rejected before any OS call is made.
- **Audit log**: Every request (approved or rejected) is written to `%LOCALAPPDATA%\com.sarfrazai.agentdesk\{env}\logs\elevated-audit.log` with timestamp, agentId, operation, params summary, and outcome.
- **No network access**: Helper has no outbound network calls. Pure local OS operations only.
- **Timeout**: Each operation has a max execution time (default 30s). The helper kills itself if no request arrives within 5 minutes of the last one (idle timeout).

### Build

```typescript
// helper/build.ts
await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "bun",
  compile: true,        // produces a single self-contained exe
  minify: true,
});
```

The built `agentdesk-helper.exe` is committed to `resources/win32/` and bundled by Electrobun into the app package.

---

## Bridge (`src/bun/elevated/bridge.ts`)

Manages the helper process lifecycle and the named pipe client connection.

### State machine

```
idle
  ↓ first request arrives
launching  (spawning helper with ShellExecute runas — triggers UAC)
  ↓ READY received on stdout
connected
  ↓ idle timeout or explicit shutdown
idle  (helper process exits on its own)
```

### Key methods

```typescript
class ElevatedBridge {
  // Launch helper (UAC prompt shown to user). Resolves when pipe is ready.
  async ensureReady(): Promise<void>

  // Send a request and wait for the matching response.
  async send(req: Omit<ElevatedRequest, "id">): Promise<ElevatedResponse>

  // Gracefully shut down the helper.
  async shutdown(): Promise<void>

  // Whether the helper process is currently running.
  get isRunning(): boolean
}

export const elevatedBridge = new ElevatedBridge();
```

### Launching with UAC elevation (Windows)

Bun has no `ShellExecute` binding, so elevation is triggered via PowerShell:

```typescript
import { spawn } from "node:child_process";

const helperPath = getHelperPath(); // resolves to bundled exe path

const launcher = spawn("powershell.exe", [
  "-NoProfile", "-NonInteractive",
  "-Command",
  `Start-Process -FilePath "${helperPath}" -ArgumentList "${sessionId}" -Verb RunAs -Wait`
], { windowStyle: "hidden" });
```

`-Verb RunAs` triggers the UAC elevation dialog. The user sees a standard Windows UAC prompt: "Do you want to allow this app to make changes to your device?" The helper then starts elevated and creates the named pipe.

### Pipe client (Windows named pipe via Node.js net module)

```typescript
import net from "node:net";

const client = net.createConnection(`\\\\?\\pipe\\agentdesk-elevated-${sessionId}`);
```

Bun's `net` module supports Windows named pipes. Messages are framed as newline-delimited JSON.

---

## Approval Gate Integration

The existing shell approval mechanism (`run_shell` → `shellApprovalMode` check → approval card in activity feed) is reused. A new approval type `elevated_exec` is added so the UI can render a distinct card (e.g., with a shield icon and "This requires administrator privileges").

### Flow

1. Agent calls `elevated_exec` tool
2. Tool checks `elevatedApprovalMode` project setting (always `"require"` — no "auto-allow" for elevated ops)
3. Emits `agentdesk:elevated-approval-request` event with operation details
4. Activity feed renders an approval card: operation name, params summary, "Allow" / "Deny"
5. On Allow: bridge generates approval token, calls `bridge.send(request)`
6. On Deny: tool returns `{ success: false, denied: true }` to agent

There is **no session-level auto-approve** for elevated operations. Every call requires explicit human approval.

---

## Agent Tool (`src/bun/agents/tools/elevated.ts`)

### Generic tool (for power users / debugging specialist)

```typescript
const elevatedExecTool = tool({
  description:
    "Execute a privileged OS operation that requires administrator rights. " +
    "ALWAYS requires human approval — never call this without a clear user request. " +
    "Prefer operation-specific tools (schedule_os_task, manage_service) when available.",
  parameters: z.object({
    operation: z.string().describe("Operation name, e.g. 'task_scheduler.create'"),
    params: z.record(z.unknown()).describe("Operation parameters"),
    reason: z.string().describe("Why this elevated operation is needed — shown to user in approval prompt"),
  }),
  execute: async (args, { abortSignal }) => { ... }
});
```

### Operation-specific tools (preferred)

These provide typed schemas and human-readable descriptions, reducing the chance of the agent passing malformed params:

```typescript
// schedule_os_task — create/update/delete Windows scheduled tasks
const scheduleOsTaskTool = tool({
  description: "Create, update, or delete a Windows Task Scheduler task at the OS level. " +
    "Requires administrator approval.",
  parameters: z.object({
    action: z.enum(["create", "update", "delete"]),
    taskName: z.string().min(1),
    // create/update fields:
    executable: z.string().optional(),
    arguments: z.string().optional(),
    trigger: z.enum(["once", "daily", "weekly", "on_logon", "on_startup"]).optional(),
    triggerTime: z.string().optional(),  // HH:MM
    runAsSystem: z.boolean().default(false),
    reason: z.string().describe("Why this task is needed"),
  }),
  execute: async (args) => { ... }
});

// manage_service — install/start/stop/uninstall Windows services
const manageServiceTool = tool({ ... });

// write_registry — write to HKLM registry keys
const writeRegistryTool = tool({ ... });

// manage_firewall_rule — add/remove Windows Firewall rules
const manageFirewallRuleTool = tool({ ... });
```

### Tool category

These are added as a new `"elevated"` category in `src/bun/agents/tools/index.ts`. They are **only available to specific agent roles** — not all agents get them by default:

| Agent | Gets elevated tools |
|---|---|
| devops-engineer | Yes |
| debugging-specialist | Yes |
| backend-engineer | No (can request via PM) |
| All others | No |

---

## Operations Reference

### `task_scheduler.create` / `task_scheduler.update`

Uses PowerShell's `Register-ScheduledTask` / `Set-ScheduledTask` cmdlets.

```typescript
// helper/src/operations/task-scheduler.ts
import { execSync } from "node:child_process";

export function createTask(params: CreateTaskParams): OperationResult {
  const ps = buildPowerShellScript(params); // parameterized, no string interpolation of user input
  const out = execSync(`powershell -NonInteractive -Command "${ps}"`, { timeout: 30_000 });
  return { success: true, output: out.toString() };
}
```

**Important**: All PowerShell scripts are built from a template with parameters passed via `-ArgumentList`, never via string interpolation of agent-supplied values. This prevents PowerShell injection.

### `task_scheduler.delete`

`Unregister-ScheduledTask -TaskName $name -Confirm:$false`

### `task_scheduler.list`

`Get-ScheduledTask | Select-Object TaskName, State, TaskPath | ConvertTo-Json`

This one does NOT require elevation but is included for completeness.

### `service.install` / `service.uninstall`

Uses `sc.exe create` / `sc.exe delete` or PowerShell `New-Service`.

### `registry.write_hklm`

`Set-ItemProperty -Path "HKLM:\..." -Name "..." -Value "..."`

### `firewall.add_rule` / `firewall.remove_rule`

`New-NetFirewallRule` / `Remove-NetFirewallRule` PowerShell cmdlets.

---

## Build & Bundling

### `package.json` additions

```json
{
  "scripts": {
    "build:helper": "bun run helper/build.ts",
    "build": "bun run build:helper && <existing build command>"
  }
}
```

### Electrobun bundling

The compiled `helper/dist/agentdesk-helper.exe` is placed in `resources/win32/`. In the Electrobun build config, it's included as an extra resource:

```typescript
// electrobun.config.ts (approximate — check electrobun docs)
extraResources: [
  { from: "resources/win32/agentdesk-helper.exe", to: "agentdesk-helper.exe" }
]
```

At runtime, the bridge resolves the helper path via:

```typescript
function getHelperPath(): string {
  if (process.env.NODE_ENV === "development") {
    return path.join(import.meta.dir, "../../helper/dist/agentdesk-helper.exe");
  }
  const { Utils } = await import("electrobun/bun");
  return path.join(Utils.paths.resourcesPath, "agentdesk-helper.exe");
}
```

### Code signing

`agentdesk-helper.exe` **must be code-signed** before distribution. An unsigned exe requesting elevation will show a scary "Unknown publisher" UAC prompt and Windows Defender may block it. Add signing to the build pipeline alongside the main app signing step.

---

## UI Changes

### New approval card type in activity feed

A new `elevated_approval` activity event type renders in the activity feed with:
- Shield icon (amber, distinct from the shell approval card's warning icon)
- Operation name and human-readable description
- Params summary (sanitized — no secrets)
- "Allow (Admin)" button (red-tinted to signal seriousness) and "Deny" button
- Text: "This operation requires administrator privileges on your system."

### Settings — Elevated Operations section

Add a new section under Project Settings:

- **Elevated operations**: Always require approval (the only option — no toggle, just an info note)
- **Audit log**: Link to open the elevated audit log file

---

## Error Handling

| Scenario | Behavior |
|---|---|
| User clicks "No" on UAC prompt | `ElevatedBridge.ensureReady()` rejects, tool returns `{ success: false, error: "UAC prompt declined" }` |
| Helper crashes mid-operation | Pipe disconnects, bridge resets to idle, tool returns error |
| Operation times out (30s) | Helper sends timeout error response, agent receives it cleanly |
| Agent passes invalid params | Zod validation in helper rejects before OS call |
| Unknown operation name | Whitelist check rejects, `NOT_WHITELISTED` error returned |
| Helper idle timeout (5 min) | Helper exits cleanly, bridge resets to idle |
| App shuts down with helper running | App shutdown hook calls `bridge.shutdown()`, sends `SHUTDOWN` command to helper |

---

## Security Threat Model

| Threat | Mitigation |
|---|---|
| Rogue process hijacks the pipe | Session ID + HMAC token — pipe name is random per session, token verified |
| Agent injects malicious commands | Whitelist of operation names; parameters passed via PowerShell `-ArgumentList`, not string interpolation |
| Helper left running after app exit | Idle timeout (5 min) + app shutdown hook |
| Agent bypasses approval gate | Approval token generated only after human approves; helper verifies token before executing |
| Unsigned helper triggers Defender | Code sign the exe in the build pipeline |
| Helper used to exfiltrate data | No network access in helper; audit log records every call |

---

## Implementation Order

When the time comes to implement, follow this sequence:

1. **Protocol types** (`helper/src/protocol.ts` + `src/bun/elevated/protocol.ts`) — define the IPC contract first, nothing else depends on it yet
2. **Helper skeleton** — `main.ts` with pipe server, no real operations yet; just echo requests back
3. **Bridge** — `ElevatedBridge` class: launch, connect, send/receive, idle timeout
4. **End-to-end smoke test** — bridge sends a test request, helper echoes it back; verify UAC flow works
5. **First operation: `task_scheduler.*`** — implement in both helper and main-side, with Zod validation
6. **Approval gate integration** — new `elevated_approval` activity card, approval token flow
7. **Agent tool** — `schedule_os_task` tool wired to bridge
8. **Remaining operations** — services, registry, firewall
9. **Generic `elevated_exec` tool** — after specific tools are proven
10. **UI settings section** — audit log link, info note
11. **Build pipeline** — `build:helper` script, Electrobun resource bundling, code signing

---

## Open Questions (resolve before implementing)

- **Electrobun resource path API**: Confirm the exact API for `Utils.paths.resourcesPath` in the version in use at implementation time — check electrobun skill/docs.
- **Named pipe in Bun**: Verify Bun's `net` module supports `\\.\pipe\...` paths on Windows at the version in use. If not, use `child_process` stdin/stdout as the IPC channel instead (simpler, though slightly less flexible).
- **PowerShell execution policy**: Some enterprise machines block PowerShell scripts. Consider `schtasks.exe` as a fallback for Task Scheduler since it's a native binary with no execution policy.
- **macOS/Linux support**: `launchd` (macOS) and `systemd`/`polkit` (Linux) are the equivalents. Separate helper binaries would be needed. Defer until there's a concrete use case on those platforms.
- **Helper code signing infrastructure**: Does the current CI/CD pipeline support EV code signing? If not, this needs to be set up before any user-facing release.
