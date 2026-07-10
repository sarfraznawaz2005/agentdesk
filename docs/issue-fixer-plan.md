# Issue Fixer — Feature Plan

> ✅ **STATUS: IMPLEMENTED (as of 2026-06).** Shipped under `src/bun/issue-fixer/` (poller, triggers,
> orchestrator, shell-guard, github, config, notify), UI in `src/mainview/components/issue-fixer/`, the
> `issue_fixer_config`/`issue_fix_runs` tables, and the hidden `issue-fixer` agent. This is the original
> plan; the code is the source of truth.
> **Scope:** GitHub only (Phase 1 = everything described here; nothing is deferred unless marked *skip-if-infeasible*).

---

## 1. Purpose

**Issue Fixer** lets AgentDesk *autonomously do real work in response to GitHub issues*. When an authorized member opens an issue (or comments) whose **title/comment contains an `agentdesk-*` trigger keyword** (or carries an `agentdesk-*` label), AgentDesk:

1. detects it by **polling** the repo (outbound — no inbound webhook, no public URL, no third party),
2. spins up a **dedicated, hidden Issue Fixer agent** inside the project,
3. does the requested **write-producing work** (fix / feature / tests / docs / refactor / review-and-improve),
4. creates a **branch**, runs the project's **tests**, **commits**, **pushes**, and **opens a Pull Request** that references the issue,
5. comments on the issue/PR for visibility, and **notifies all connected channels** (Discord/email) on **success and failure**,
6. **never merges** — humans merge.

It also supports a **PR-feedback loop**: an authorized member can comment an `agentdesk-*` keyword on the agent's PR and the agent updates the branch.

### Why this shape
- **Privacy + reliability by construction.** Polling the GitHub REST API is an *outbound* call from the user's machine to the host they already trust. No relay, tunnel, ngrok, public URL, or third-party service. Data never leaves the user↔GitHub path. This sidesteps the entire NAT/inbound-webhook problem.
- **Reuses existing machinery.** GitHub polling, the autonomous-agent path (`runInlineAgent` / `review-cycle`), git tools, real PR creation, the hidden-agent pattern (Playground), project-scoped settings, channel notifications, and the dashboard active-agent count all already exist.
- **Real work, not analysis.** Only intents that *write files* are supported. This is not a Q&A/triage bot.

### Non-goals
- ❌ Merging PRs or branches (humans only — strict, multi-layer enforcement).
- ❌ Inbound webhooks / public endpoints (polling only).
- ❌ GitLab/Bitbucket/others (GitHub only for now).
- ❌ Read-only/analysis-only intents (no value here; the feature produces commits + PRs).
- ❌ Kanban tasks, plan-approval cards, or PM orchestration (explicitly bypassed).

---

## 2. Architecture decision: project-integrated, dedicated hidden agent

### 2.1 Lives inside a Project (not a new top-level page)
A project already carries everything the feature needs — `workspacePath`, `githubUrl`, `workingBranch` (`project-settings-tab.tsx:44-54`) — plus project-scoped settings (`rpc.saveProjectSetting` / `getProjectSettings`, `:659,:1072`) and a tabbed settings container (General / AI / Integrations, `:1120-1148`). A separate page would duplicate this model. **Users must create a project first** (its workspace = the local git clone of the repo).

**Model: one project = one repo/workspace = one Issue Fixer config** (one project has exactly one GitHub repo / `githubUrl`). To watch multiple repos, create multiple projects (each repo needs its own local workspace anyway). *(Confirmed.)*

### 2.2 Execution path: dedicated hidden `issue-fixer` agent via `runInlineAgent` — NOT the PM
The PM path triggers planning, the **yellow approval card** (only ever produced by the PM tool `request_plan_approval`), and **kanban tasks** (only created by explicit kanban tools / the review-cycle). Calling `runInlineAgent` **directly** — the Playground / `review-cycle.ts` pattern — bypasses all of that automatically:
- **No PM, no approval card, no kanban, no review-cycle.**
- Runs inside a **per-run conversation** in the project, so activity streams into the UI via the existing message-part broadcasts.
- **Hidden agent** like `playground-agent`: built-in, **excluded from the Agents page** (`getAgentsList`) and **from the PM** (`prompts.ts`), never orchestrated, zero `agent_tools` rows ⇒ full tool registry.

### 2.3 Tools available to the Issue Fixer agent
- **Full registry** (file ops, web, **all skills**) — same as Playground.
- **+ chrome-devtools MCP** — *included* (Playground excludes it; Issue Fixer keeps it for reproducing UI bugs).
- **+ git tools** — `git_status`, `git_diff`, `git_log`, `git_branch` (list/create/switch), `git_commit`, `git_push`, `git_pr` (**create/list only** — there is no merge action), `git_stash`.
- **+ auto-approved shell** — a *guarded* variant of `autoApprovedShellTool`, scoped to the workspace, with a **merge/force-push denylist** (see §6).
- **Excluded:** `request_human_input` (no UI to answer it mid-run); any merge-capable tool (none exist today, but enforced — see §6).

### 2.4 Dashboard visibility (no sidebar indicator)
Per decision: **no sidebar spinner.** Instead, the run **counts toward the project card's active-agent count on the dashboard**. This is automatic: the orchestrator calls `registerAgentController(projectId, abort, "issue-fixer")` / `unregisterAgentController(...)` (as `review-cycle.ts:292,320` does), which feeds `getRunningAgentCount` → the dashboard's per-project `agentCount` (`engine-manager.ts:70`, `rpc-registration.ts:833-852`). A small in-page "running" indicator appears on the Issue Fixer **tab/Activity view** only.

---

## 3. UX / Layout

### 3.1 Configuration → **Project Settings → new `Issue Fixer` tab**
Added alongside General / AI / Integrations (`project-settings-tab.tsx:1120-1148`). Contains all configuration (§5).

### 3.2 Live + logs → **new project-view tab `Issue Fixer`**
Added to the project tab set (Chat / Kanban / Docs / Git / Deploy → **+ Issue Fixer**) by extending the `ProjectTab` union and render switch (`project.tsx:18,161-319`). Two sub-tabs (via the `Tabs` primitive):

- **Activity** — the current/last run rendered **like the Playground agent**: the agent's tool calls stream in live as message parts. Idle: *"Watching `owner/repo` · last checked 2m ago · 0 queued."* Shows a small running spinner while active.
- **History** — a table of every issue **seen**: time · #/title · author · trigger matched? · intent · status (`ignored`/`queued`/`fixing`/`testing`/`pushing`/`pr_created`/`failed`) · PR link · duration. Row click → detail drawer: full agent transcript, the diff, the PR link, and any error.

---

## 4. Trigger · Intent · Authorization model

### 4.1 Keyword prefix rule
**Every keyword and label is prefixed `agentdesk-`. All matching is case-insensitive.** There is **no bare `agentdesk` keyword**. Only **write-producing** intents are supported.

Predefined keyword set (shown in settings with help text):

| Keyword / Label | Intent | Agent behavior (all produce file changes → PR) |
|---|---|---|
| `agentdesk-fix` | Fix | Diagnose and fix the reported bug/error |
| `agentdesk-feature` | Feature | Implement the described feature |
| `agentdesk-test` | Tests | Add or repair tests |
| `agentdesk-docs` | Docs | Write/update documentation files |
| `agentdesk-refactor` | Refactor | Restructure code without changing behavior |
| `agentdesk-review` | Review & improve | Review the code/PR **and apply concrete improvements as commits** (not just comments — it writes changes, so it qualifies as real work) |

Custom keywords are allowed but **must be `agentdesk-` prefixed** (validated in the UI). The keyword picker is a **multi-select with predefined options + add/remove** (built on the existing `command.tsx` combobox + `badge`s, since no tags component exists). Each option displays the keyword and its description.

### 4.2 Where keywords match
- ✅ **Issue title**
- ✅ **Comment** by an authorized member (issue comments **and** PR comments — see §4.5)
- ❌ **Issue body** (explicitly **not** matched)
- ✅ **Label** — an `agentdesk-*` label on the issue (label-gated mode; recommended because labels are permission-gated natively)

### 4.3 Authorization gate (security — critical)
A trigger fires only when **keyword/label matches AND the actor is authorized**:
- **Author association** is `OWNER`, `MEMBER`, or `COLLABORATOR` (from the GitHub API), **or**
- the trigger is an **`agentdesk-*` label** (only users with write access can add labels).

Without this, anyone could title a public-repo issue `agentdesk-fix` and run your agent. Default: collaborators-only **and** label-gated both accepted.

### 4.4 Anti-runaway controls
- **Cursor** — on enable, only consider issues/comments created **after** the enable timestamp (don't retroactively process old issues).
- **Dedup** — each `(issueNumber, triggerCommentId|title|label)` processed once.
- **Cooldown / max-fixes-per-hour** — configurable rate cap per project.
- *(No token/cost budget — per your instruction.)*

### 4.5 PR-feedback loop (included now, not deferred)
The poller also scans **comments on the agent's open PRs**. An authorized member commenting an `agentdesk-*` keyword on the PR → the agent **checks out that PR's branch, applies the requested change, and pushes** (updating the same PR). Same keyword→intent and authorization rules. *(Feasible with the GitHub API: list PR comments, resolve the PR's head branch, push to it. Build it; skip only if a blocker emerges.)*

---

## 5. Configuration options & where (Project Settings → Issue Fixer tab)

| Setting | Type | Notes |
|---|---|---|
| **Enable automatic issue fixing** | toggle | Master on/off for this project |
| **Repo / workspace / base branch** | read-only display | Inherited from project (`githubUrl`, `workspacePath`, `workingBranch`); edited in General |
| **Trigger keywords** | multi-select (predefined + custom) | All `agentdesk-*`, case-insensitive; help text explains the prefix rule |
| **Trigger labels** | multi-select | `agentdesk-*` labels; recommended (permission-gated) |
| **Authorization rule** | select | Collaborators-only / Label-gated / Both |
| **Poll interval** | dropdown | Options: 15 minutes · 30 minutes · **Hourly** *(default)* · Every 2 hours · Every 3 hours · Every 5 hours. Stored as minutes (`15`, `30`, `60`, `120`, `180`, `300`) |
| **Autonomy** | select | `Branch + PR (no merge)` *(default)* · `Dry-run / Draft PR` |
| **Test/build command** | text | PR gate — only open a non-draft PR if it passes |
| **Custom instructions** | textarea | Repo coding standards, "always add a test", etc. — injected into the agent prompt |
| **GitHub token source** | select + input | **Use global default** (`github_pat`) **or Custom token** for this project (stored per-project). Covers users with multiple repos/tokens |
| **Cooldown / max fixes per hour** | numbers | Anti-runaway |
| **Notify channels** | multi-select | Which connected channels get success+failure summaries |
| **Status** | read-only | Health + last-polled timestamp |

---

## 6. Strict "no merge" enforcement (three layers)

1. **System prompt** — explicit, hard rule: *never merge PRs or branches; only humans merge; only push to the dedicated issue-fix branch.*
2. **Toolset** — `git_pr` exposes **create/list only** (no merge action); there is **no `git_merge` tool**; the UI merge RPCs (`pulls.ts` / `rpc/git.ts` merge/rebase/squash) are **not agent tools** and are unreachable. Confirmed in code; enforced by not adding any merge tool.
3. **Guarded auto-shell denylist** — the only escape hatch is the auto-approved shell. The Issue Fixer's shell wrapper **rejects**: `git merge`, `git rebase` onto the base branch, `gh pr merge`, any push to the **base/working branch**, `--force`/`-f` pushes, and `git reset --hard` on the base. Pushes are restricted to the run's `issue-fix/*` branch.

---

## 7. Execution flow (per triggered issue)

```
Poller (per enabled project, every N min, OUTBOUND GitHub API)
  ├─ GET issues + issue comments + open-PR comments since cursor (resolved token)
  ├─ Trigger gate: keyword in TITLE or authorized COMMENT, or agentdesk-* LABEL
  │                 AND author authorized (OWNER/MEMBER/COLLABORATOR | label)
  ├─ Dedup + cooldown + max/hour
  └─ Resolve intent from keyword → enqueue run
Queue (SEQUENTIAL per project; avoids git conflicts)
  1. Create issue_fix_runs row → status "queued"; broadcast; register controller (→ dashboard count)
  2. Ensure workspace is a clean git repo; checkout + pull base branch (stash/abort if dirty)
  3. Create branch  issue-fix/<number>-<slug>   (or check out PR head branch for PR-feedback)
  4. Comment on issue:  "🤖 Working on this…"
  5. runInlineAgent(issue-fixer, intent-specific prompt, task = title+body+comments+repo context)
        tools: full registry + chrome-devtools + git + guarded auto-shell; exclude request_human_input
  6. Test/build gate: run configured command
        pass → real PR · fail (or dry-run) → DRAFT PR or status "failed"
  7. git_commit on the branch
  8. git_push the branch   (token-injected auth — see §11)
  9. git_pr create → body "Fixes #<number>"  (NEVER merged; left for human review)
 10. Comment on issue: "✅ Done — see PR #<M>"
 11. Record run (status, diff ref, PR url, duration); unregister controller
 12. Notify ALL configured channels with a summary — on SUCCESS and FAILURE
```

---

## 8. The Issue Fixer agent

### 8.1 Definition (seed)
Add a built-in agent `issue-fixer` (display "Issue Fixer") in `seed.ts`, mirroring `playground-agent`: **hidden from the Agents page** (exclude in `getAgentsList`), **hidden from the PM** (exclude in `prompts.ts`), never orchestrated, zero `agent_tools` rows. A migration inserts it for existing users (and removes any legacy name collision, following the `general-agent`→`playground-agent` precedent).

### 8.2 Dynamic system prompt (by intent)
A prompt builder swaps the task framing per intent. Shared core:

```
You are the AgentDesk Issue Fixer — an autonomous engineer working on a single GitHub issue.

Workspace: <absolute workspacePath>  (a git repo; base branch: <workingBranch>)
You are already on branch: issue-fix/<n>-<slug>

ABSOLUTE RULES:
- NEVER merge a pull request or branch. Only humans merge. Do not run `git merge`,
  `gh pr merge`, rebase onto or push to the base branch, or force-push.
- Only commit and push to your dedicated branch above.
- Do not request human input; if you cannot complete the task confidently,
  stop and write a clear explanation instead of pushing low-quality changes.
- Keep changes minimal and focused on the issue. Follow the repo's conventions
  and the custom instructions below.

Custom project instructions: <customInstructions or "none">

Task (intent = <intent>):
<intent-specific directive>     # fix / feature / test / docs / refactor / review-and-improve

The issue:
  #<number> — <title>
  <body>
  <relevant comments>

When done: ensure the project builds/tests pass (the configured command will be
run as a gate), write a concise summary, and reference the issue as "Fixes #<number>"
in the PR you open via git_pr (create only — never merge).
```

Intent directives, e.g.:
- **fix:** "Reproduce, find the root cause, and implement the minimal correct fix."
- **feature:** "Implement the described feature end-to-end, with tests if the repo has a test setup."
- **test:** "Add or repair tests covering the described behavior; do not change production behavior."
- **docs:** "Create/update the relevant documentation files."
- **refactor:** "Restructure the named code without changing behavior; keep tests green."
- **review:** "Review the code/PR and apply concrete improvements as commits."

---

## 9. Data model

### 9.1 New table `issue_fixer_config` (one row per project)
`projectId` (PK/FK) · `enabled` · `keywords` (JSON) · `labels` (JSON) · `authMode` (`collab`/`label`/`both`) · `pollIntervalMin` · `autonomy` (`branch_pr`/`draft`) · `testCommand` · `customInstructions` · `tokenSource` (`global`/`custom`) · `customTokenRef` (settings key for the encrypted/custom token) · `cooldownSec` · `maxPerHour` · `notifyChannels` (JSON) · `cursorAt` (enable timestamp) · `lastPolledAt` · `createdAt` · `updatedAt`.

### 9.2 New table `issue_fix_runs` (history/logs)
`id` · `projectId` · `issueNumber` · `issueTitle` · `issueUrl` · `triggerType` (`title`/`comment`/`pr_comment`/`label`) · `triggerKeyword` · `triggerCommentId` (nullable, for dedup) · `intent` · `author` · `authorized` (bool) · `status` · `branchName` · `prNumber` · `prUrl` · `testPassed` (nullable) · `conversationId` · `summary` · `error` · `startedAt` · `finishedAt`. Unique index on `(projectId, issueNumber, triggerCommentId)` for dedup.

### 9.3 Settings
- Global GitHub PAT stays `github_pat` (category `github`).
- Per-project custom token (if `tokenSource = custom`) stored via `saveProjectSetting(projectId, "issueFixerToken", …)`.
- All other config can live in `issue_fixer_config` (preferred) rather than scattered settings keys.

> Schema changes require a **new migration file** in `src/bun/db/migrations/` (never edit `schema.ts` without the matching migration). Backfill is unnecessary (new tables; feature disabled by default).

---

## 10. Backend modules

```
src/bun/issue-fixer/
  poller.ts        # per-project poll loop (driven by cron-scheduler); fetch issues/comments/PR-comments
  triggers.ts      # keyword/label/author matching + intent resolution + dedup/cooldown/cursor
  github.ts        # issue/comment/PR-comment fetch, PR create, issue/PR comment post (reuse githubFetch + pulls.ts)
  orchestrator.ts  # the run: branch → agent → test gate → commit → push → PR → comments → notify
                   #   (clone of playground/orchestrator.ts; uses runInlineAgent, registerAgentController,
                   #    guarded auto-shell, broadcasts agentdesk:issuefixer-*)
  prompts.ts       # dynamic intent system-prompt builder
  shell-guard.ts   # guarded autoApprovedShellTool variant (merge/force-push/base-branch denylist)
```

Wire the poller into the existing **cron scheduler** (`cron-scheduler.ts`) so it runs restart-safe at each project's interval, and into app init (`src/bun/index.ts`).

---

## 11. Bug fixes required for autonomy (do now)

1. **GitHub token key mismatch.** `github-api.ts:13` reads `github_pat` (category `github`); `git.ts:449` (the `git_pr` tool) reads `githubToken` (category `git`). **Unify** on `github_pat`/`github`, and route through the new **per-project override** (`tokenSource`). Without this, autonomous PR creation silently fails to authenticate.
2. **Autonomous push auth.** Today `git_push` (tool) is approval-gated and `gitPush` (`rpc/git.ts:98-106`) injects no credentials. For hands-off pushing, the Issue Fixer flow must **authenticate the push with the resolved token** — inject it into the remote URL for the push (`https://x-access-token:<token>@github.com/<owner>/<repo>.git`) or configure a scoped credential helper — used only for the issue-fix branch push, never the base branch.

---

## 12. RPC, frontend, notifications

### 12.1 RPC (contract in `src/shared/rpc/`, handler in `src/bun/rpc/`, register in `rpc-registration.ts`, client in `lib/rpc.ts`)
- `getIssueFixerConfig(projectId)` / `saveIssueFixerConfig(projectId, config)`
- `listIssueFixRuns(projectId, paging)` / `getIssueFixRun(runId)`
- `triggerIssueFixManually(projectId, issueNumber)` *(optional convenience)*
- `cancelIssueFixRun(runId)` · `pollNow(projectId)`

### 12.2 Frontend
- `components/project-settings/` → **IssueFixerSettingsTab** (the config form; keyword multi-select on `command` + `badge`).
- `components/issue-fixer/` → **IssueFixerTab** (project-view tab) with **Activity** (Playground-style live stream) + **History** (runs table + detail drawer).
- `project.tsx` → add `"issue-fixer"` to `ProjectTab`, a tab button, and `{activeTab === "issue-fixer" && <IssueFixerTab projectId={projectId} />}`.
- `project-settings-tab.tsx` → add the `Issue Fixer` `TabsTrigger`/`TabsContent`.
- **Store** `stores/issue-fixer-store.ts` (+ event handlers) mirroring the Playground store; broadcasts `agentdesk:issuefixer-runStarted|part|partUpdated|agentComplete|runComplete|runError`.

### 12.3 Notifications
On **PR created (success)** and on **failure**, send a summary to **all configured connected channels** via the existing channel manager (`broadcastTaskDoneNotification`-style). Include issue #, intent, PR link (or error), and a one-line summary.

---

## 13. Resolved decisions

1. **One repo per project** — confirmed. Each project has exactly one GitHub repo / `githubUrl`. Multiple repos = multiple projects.
2. **`agentdesk-review`** — kept, scoped to *applying* improvements as commits (it writes files, so it qualifies as real work).
3. **Poll interval** — a **dropdown**, default **Hourly**, with options 15 minutes · 30 minutes · Hourly · Every 2 hours · Every 3 hours · Every 5 hours (stored as minutes: 15/30/60/120/180/300).

---

## 14. Phasing

Everything above is **Phase 1** (per your instruction — nothing deferred), including the **PR-feedback loop** (build it; skip only if a concrete blocker appears). The only thing explicitly out of scope is **non-GitHub providers**.

---

## 15. Existing code leveraged

GitHub polling + `githubFetch` + `github_issues` (`webhooks.ts`, `github-api.ts`) · cron scheduler (`cron-scheduler.ts`) · autonomous dispatch (`runInlineAgent`, `review-cycle.ts`) · git tools + real PR (`tools/git.ts`, `pulls.ts`) · `autoApprovedShellTool` (`tools/shell.ts`) · hidden-agent pattern + live streaming (Playground `orchestrator.ts`, seed/prompts/`getAgentsList`) · dashboard count (`engine-manager.ts:70`, `rpc-registration.ts:833-852`) · channel notifications (`channels/manager.ts`) · project-scoped settings + Project Settings tabs (`project-settings-tab.tsx`).
