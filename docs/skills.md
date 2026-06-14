# Skills System — AgentDesk

> Definitive spec for the skills system. Read this before touching any skills-related code.

---

## Overview

Skills extend what AgentDesk agents can do. A skill is a directory containing a
`SKILL.md` file with YAML frontmatter (metadata) and markdown instructions.

Skills use a **compact prompt injection** approach to save tokens: only skill
names and one-line descriptions are injected into agent system prompts. Agents
decide for themselves whether a skill is relevant to their task, and load full
skill content on demand using the `read_skill` tool. They can also search for
skills by keyword using `find_skills`.

Skills are **filesystem-only** — they are never stored in the database. The app
discovers skills from a well-known directory on startup. Users create and edit
skills outside the app using their OS file editor. The UI provides a read-only
Skills page for browsing discovered skills and a button to open the skills folder
in the OS file explorer.

The skill format is **compatible with the Claude Code / Agent Skills open standard**.
Skills created for Claude Code work in AgentDesk and vice versa.

---

## Skills Directories

Skills are loaded from two directories:

### 1. Built-in Skills (read-only, shipped with app)

```
Resources/app/skills/     (in the app bundle)
```

Source: `skills/` in the project root. Copied into the bundle via
`electrobun.config.ts` → `build.copy: { "skills": "skills" }`. At runtime,
resolved via `import.meta.dir` (same pattern as bundled plugins).

### 2. User Skills (read-write)

```
{userData}/skills/
```

Concrete path (Windows): `C:\Users\{user}\AppData\Local\com.sarfrazai.agentdesk\dev\skills\`

Resolved via `Utils.paths.userData` + `/skills/`. Created automatically on first
startup if it doesn't exist. The `openSkillsFolder` RPC also ensures the
directory exists before opening it.

### Load Order

Built-in skills load first, then user skills. If a user skill has the same name
as a built-in skill, the user skill **overrides** it. This lets users customize
or replace built-in skills without modifying the app bundle.

Each skill is a subdirectory containing `SKILL.md` as the required entrypoint:

```
skills/
├── explain-code/
│   ├── SKILL.md              # Required — frontmatter + instructions
│   ├── reference.md          # Optional supporting file
│   ├── examples/
│   │   └── sample.md         # Optional example output
│   └── scripts/
│       └── validate.sh       # Optional script the agent can execute
├── api-conventions/
│   └── SKILL.md
└── deploy/
    ├── SKILL.md
    └── scripts/
        └── deploy.sh
```

---

## SKILL.md Format

### Frontmatter (YAML)

`name` and `description` are **required**. The other fields are optional.

```yaml
---
name: my-skill
description: What this skill does and when to use it
allowed-tools: read_file, search_files, run_shell
argument-hint: "[issue-number]"
agent: frontend_engineer
---
```

| Field                      | Type    | Required | Description |
|----------------------------|---------|----------|-------------|
| `name`                     | string  | **Yes**  | Skill name. **Must exactly equal the parent directory name.** Lowercase letters, numbers, and hyphens only; max 64 chars; must not start or end with a hyphen; no consecutive hyphens (`--`). Validation failures are recorded in `errors`. |
| `description`              | string  | **Yes**  | What the skill does. Agents see this in their compact listing. Falls back to the first paragraph of the body only when assembling a description for display; a missing/blank `description` is still a validation error (max 1024 chars). |
| `allowed-tools`            | string  | No       | Tool names the skill references (informational — shown in UI). Parsed by splitting on commas **or** whitespace, so both `Read, Grep` and `Read Grep` work. |
| `argument-hint`            | string  | No       | Hint for expected arguments, e.g. `[issue-number]`. Shown in UI. |
| `agent`                    | string  | No       | Preferred agent role (e.g. `frontend_engineer`, `backend-engineer`). Informational — shown in listings. |
| `hidden`                   | boolean | No       | When `true`, the skill is hidden from the Skills UI (but still available to agents). |
| `feature`                  | string  | No       | Feature gate. When set (e.g. `freelance`), the skill is only included in agent prompts and the UI when that feature is enabled. |

> **Removed fields**: `disable-model-invocation` and `user-invocable` are no
> longer used. All discovered skills are loaded and visible to all agents. The
> LLM decides relevance itself.

### Markdown Body

Everything after the closing `---` is the skill's instruction content. Agents
load this on demand via the `read_skill` tool.

#### String Substitutions

| Variable                | Description |
|-------------------------|-------------|
| `$ARGUMENTS`            | All arguments passed when invoking the skill. |
| `$ARGUMENTS[N]`         | Specific argument by 0-based index. |
| `$N`                    | Shorthand for `$ARGUMENTS[N]` (e.g. `$0`, `$1`). |
| `${AGENTDESK_SKILL_DIR}` | Absolute path to the skill's directory. Use to reference bundled scripts/files. |
| `${AGENTDESK_SKILLS_USER_DIR}` | Absolute path to the user skills directory. Use when creating new skills. |

#### Dynamic Context Injection

The `` !`command` `` syntax runs a shell command **before** the skill content is
sent to the agent. The command output replaces the placeholder.

```markdown
## Current git status
!`git status --short`

## Recent commits
!`git log --oneline -5`
```

This is **preprocessing** — agents never see the commands, only the output.

### Supporting Files

Additional files in the skill directory are not loaded automatically. Reference
them from `SKILL.md` so agents know what's available:

```markdown
## Additional resources
- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
- To run validation: `bash ${AGENTDESK_SKILL_DIR}/scripts/validate.sh`
```

Agents can read these files using their `read_file` tool when needed.

---

## Discovery & Loading

### When Discovery Happens

Skills are discovered **once on app startup**. The app scans the skills directory,
parses all `SKILL.md` files, and builds an in-memory registry. Users can also
trigger a manual refresh from the Skills page UI.

There is no file watcher — changes to skills require an app restart or manual
refresh from the UI.

### Discovery Process

1. Scan `{userData}/skills/` for subdirectories containing `SKILL.md`
2. Parse YAML frontmatter from each `SKILL.md`
3. Extract markdown body (everything after frontmatter)
4. Resolve skill name: frontmatter `name` field, or directory name as fallback
5. List supporting files (other files in the skill directory)
6. Store in `SkillRegistry` (in-memory `Map<name, Skill>`)

**All discovered skills are loaded — there is no enabled/disabled toggle.**
Visibility, however, is filtered: a skill marked `hidden: true` is omitted from the
Skills UI, and a skill with a `feature` gate (e.g. `freelance`) is omitted from both
the UI and agent prompts when that feature is disabled. The UI visibility check
(`isSkillVisible` in `src/bun/rpc/skills.ts`) filters on both `hidden` and the feature
gate; agent prompts (`buildSkillsDescriptionSection` in `src/bun/agents/prompts.ts`)
filter on the feature gate only.

### Skill Object Shape

```typescript
interface Skill {
  name: string;                    // e.g. "explain-code"
  description: string;             // from frontmatter or first paragraph
  dirPath: string;                 // absolute path to skill directory
  filePath: string;                // absolute path to SKILL.md
  content: string;                 // raw markdown body (without frontmatter)
  allowedTools: string[];          // e.g. ["Read", "Grep"]
  argumentHint?: string;           // e.g. "[issue-number]"
  preferredAgent?: string;         // e.g. "frontend_engineer"
  supportingFiles: string[];       // relative paths of other files in skill dir
  errors: SkillValidationError[];  // frontmatter validation errors ([] = valid)
  isBundled: boolean;              // true = ships with the app; false = user-installed
  hidden: boolean;                 // true = hidden from Skills UI (still available to agents)
  feature?: string;                // optional feature gate (e.g. "freelance")
}
```

---

## Agent Integration — Compact Mode

### Design Rationale

To save tokens, we do NOT inject full skill content into system prompts. Instead
we use a **compact mode**: only skill names and one-line descriptions are listed.
Agents decide for themselves whether a skill is relevant and load content on
demand. This keeps prompts lean even with many installed skills.

### How Agents Discover Skills

A compact "Available Skills" section is appended to every agent's system prompt:

```
## Available Skills

The following skills are installed. Use `read_skill` to load a skill's full
instructions when relevant. Use `find_skills` to search for skills by keyword.

- **explain-code**: Explains code with visual diagrams and analogies
- **api-conventions**: API design patterns for this codebase
- **react-best-practices**: React 19 patterns, hooks rules, optimization [agent: frontend_engineer]
```

This section is **always present** for all agents (PM and sub-agents). Discovered
skills are listed except those behind a disabled `feature` gate, which are filtered
out of the prompt (see `buildSkillsDescriptionSection` in `prompts.ts`).

### How Agents Use Skills

Agents have four skill tools available:

| Tool | Description |
|------|-------------|
| `read_skill` | Loads the full content of a skill by exact name. Returns the resolved SKILL.md body (after substitutions and bash injections), plus the skill directory path and a list of supporting files with full paths. Agents call this when they determine a skill is relevant to their current task. |
| `read_skill_file` | Reads a supporting file from a skill's directory by full path. Used after `read_skill` to access companion docs, scripts, or reference files. Path-guarded to skills directories; refuses binary files and caps size at 512KB. |
| `find_skills` | Searches skill names and descriptions by keyword query. Returns matching skill summaries. Agents use this when they need to discover skills beyond the compact listing (e.g. searching for a concept). |
| `validate_skill` | Validates a skill directory after creating or editing it. Parses SKILL.md, checks frontmatter, naming conventions, line count, and structure, and returns errors/warnings. Should be called after creating a skill. |

**The LLM decides relevance** — no auto-matching or keyword overlap scoring is
performed by the engine. The system prompt tells agents about the tools and the
agent decides when to use them.

### Prompt Injection Wording

The skills section in the system prompt includes guidance:

```
## Available Skills

The following skills are installed and can provide specialized instructions for
your tasks. When a skill looks relevant to your current work:
1. Call `read_skill` with the skill name to load its full instructions
2. Follow the loaded instructions for the task at hand
Use `find_skills` with a keyword if you need to search for skills.

- **skill-name**: one-line description
...
```

### No _activeSkill or Auto-matching

The previous approach of `_activeSkill` in the engine and keyword-based
`matchForAgent()` auto-matching is removed. Skills are purely agent-driven:
compact listing in prompt → agent decides → `read_skill` on demand.

---

## Content Resolution Pipeline

When `read_skill` is called, the content goes through a resolution pipeline:

1. **Retrieve** — Look up skill by name in the registry
2. **Bash injection** — Execute all `` !`command` `` blocks and replace with output
3. **Argument substitution** — Replace `$ARGUMENTS`, `$0`, `$1`, `${AGENTDESK_SKILL_DIR}`
4. **Return** — Full resolved content returned as tool result

---

## Agent Tools

### `read_skill`

Available to all agents (PM and sub-agents).

**Parameters:**
- `name` (string, required) — Exact skill name as listed in Available Skills

**Returns:** Full resolved skill content (markdown body with substitutions applied),
followed by the skill directory path and a list of supporting text files with full
paths, plus a mandatory-compliance checklist.

**Error:** Returns error message with list of available skill names if not found.

### `read_skill_file`

Available to all agents (PM and sub-agents).

**Parameters:**
- `file_path` (string, required) — Full absolute path to the file (as shown in `read_skill` output)

**Returns:** The file's text content. Path must be inside a skills directory
(bundled or user); binary files are rejected and files larger than 512KB are refused.

### `find_skills`

Available to all agents (PM and sub-agents).

**Parameters:**
- `query` (string, required) — Search keyword(s)

**Returns:** Array of matching skills with name and description. Matches against
skill names and descriptions (case-insensitive substring match).

### `validate_skill`

Available to all agents (PM and sub-agents).

**Parameters:**
- `skill_dir` (string, required) — Absolute path to the skill directory (folder containing SKILL.md)

**Returns:** JSON validation result — `valid` flag, parsed name/description/line count,
`allowedTools`, supporting files, an `errors` array (frontmatter + content checks such
as line count > 500 and hardcoded absolute paths), and optional `warnings` (e.g. bloat
files like `package.json` or `README.md`).

---

## UI — Skills Page

The Skills page is **read-only**. It shows discovered skills and provides
utilities for managing the skills directory.

### Layout

- **Header**: "Skills" title + skill count + search/filter input + "Refresh" button + "Open Skills Folder" button
- **Info banner**: Brief guide on skill format, `read_skill` usage, and inline "click here" link to Available Tools Reference dialog
- **Available Tools Reference**: Dialog listing all agent tools grouped by category — helps users know valid names for the `allowed-tools` frontmatter field
- **Skills grid**: 2-column card grid. Each card has:
  - **Header bar** (gray, matching project card style): skill name + preferred agent badge + edit (pencil) icon button
  - **Body**: description, supporting files count, argument hint
  - Click card body → opens **Skill Detail Dialog**
- **Skill Detail Dialog**: Shows skill name, agent badge, description, tools (with semi-bold names), and full SKILL.md content rendered as formatted markdown
- **Empty state**: Guidance message + "Open Skills Folder" button

### User Actions

| Action | How |
|--------|-----|
| Browse skills | Skills page (2-column grid) |
| View skill content | Click card → detail dialog with rendered markdown |
| Filter skills | Type in search input (header, partial + case-insensitive match) |
| View available tools | Click "click here" link in info banner → tools reference dialog |
| Create a skill | Open skills folder in OS, create directory + SKILL.md |
| Edit a skill | Click pencil icon on skill card header — opens SKILL.md in OS default editor |
| Delete a skill | Open skills folder in OS, delete the directory |
| Refresh discovery | Click "Refresh" button on Skills page — re-reads skills folder |

---

## RPC Layer

### Contract (`src/shared/rpc/skills.ts`)

```typescript
skills: {
  getSkills: { params: {}; response: SkillSummary[] };
  getSkill: { params: { name: string }; response: SkillDetail | null };
  refreshSkills: { params: {}; response: { count: number } };
  getSkillsDirectory: { params: {}; response: { path: string } };
  openSkillInEditor: { params: { name: string }; response: { success: boolean; error?: string } };
  openSkillsFolder: { params: {}; response: { success: boolean } };
  deleteSkill: { params: { name: string }; response: { success: boolean; error?: string } };
  getAvailableTools: { params: {}; response: Array<{ name: string; category: string; description: string }> };
}
```

### Handlers (`src/bun/rpc/skills.ts`)

- `getSkills()` — returns all skills from registry (summary: name, description, metadata)
- `getSkill(name)` — returns full detail including content and supporting files
- `refreshSkills()` — triggers `registry.reload()`, returns new count
- `getSkillsDirectory()` — returns the skills directory absolute path
- `openSkillInEditor(name)` — opens the skill's SKILL.md in the OS default editor
- `openSkillsFolder()` — ensures directory exists (mkdirSync), opens in OS explorer
- `deleteSkill(name)` — deletes a user-installed skill's directory via `registry.deleteSkill`; refuses bundled skills (returns `{ success: false, error }`)
- `getAvailableTools()` — returns all agent tool definitions (name, category, description) for the UI reference dialog

---

## File Map

### New/Modified Files

```
skills/                          # Built-in skills (copied into bundle via build.copy)
├── agentdesk-guide/
│   └── SKILL.md
src/bun/skills/
├── loader.ts          # Parse SKILL.md, frontmatter, bash injection, substitutions
├── registry.ts        # In-memory SkillRegistry, dual-dir loading (bundled + user)
src/bun/agents/tools/
├── skills.ts          # read_skill, read_skill_file, find_skills, validate_skill tools (all agents)
src/bun/rpc/
├── skills.ts          # RPC handlers
src/shared/rpc/
├── skills.ts          # RPC contract types
src/mainview/pages/
├── skills.tsx         # Skills page (read-only listing)
src/bun/agents/prompts.ts        # Compact skills listing in system prompts
src/bun/agents/engine.ts         # PM tools include read_skill, find_skills
src/bun/agents/agent-loop.ts     # Sub-agents get skill tools via toolRegistry
src/bun/agents/tools/index.ts    # Register skill tools in toolRegistry (all agents)
src/mainview/components/chat/message-parts.tsx  # Tool call cards render skill tool calls inline
src/bun/rpc/dashboard.ts         # Dashboard PM chatbot — skill-aware system prompt + read_skill/find_skills tools
src/bun/rpc-registration.ts      # Register skill RPCs
src/bun/index.ts                 # Initialize SkillRegistry on startup
src/mainview/lib/rpc.ts          # Skill RPC client wrappers
src/mainview/router.tsx          # /skills route
src/mainview/components/layout/sidebar.tsx  # Skills nav item
electrobun.config.ts             # build.copy includes "skills": "skills"
```

---

## Example Skill

```yaml
---
name: react-best-practices
description: React 19 patterns, hooks rules, and performance optimization. Use when writing React components, hooks, or optimizing renders.
agent: frontend_engineer
allowed-tools: read_file, search_files, search_content
---

# React 19 Best Practices

When writing React components in this codebase:

## Component Patterns
- Use functional components with hooks exclusively
- Prefer `use` hook for data fetching (React 19)
- Use `useOptimistic` for optimistic UI updates
- Memoize with `useMemo`/`useCallback` only when profiling shows a need

## State Management
- Local state: `useState` / `useReducer`
- Global state: Zustand stores (see src/mainview/stores/)
- Server state: React Query or `use` hook

## File Organization
- One component per file
- Co-locate styles, tests, and types with components
- Use barrel exports (index.ts) for public APIs only

## For detailed API reference, see:
- [hooks-reference.md](hooks-reference.md)
- [performance-checklist.md](performance-checklist.md)
```

---

## Compatibility with Claude Code

| Feature | Claude Code | AgentDesk | Notes |
|---------|-------------|-------------|-------|
| SKILL.md with YAML frontmatter | Yes | Yes | Same format |
| Supporting files | Yes | Yes | Same structure |
| `$ARGUMENTS` substitution | Yes | Yes | Same syntax |
| `` !`command` `` bash injection | Yes | Yes | Same syntax |
| `name` field | Yes | Yes | |
| `description` field | Yes | Yes | |
| `allowed-tools` | Yes | Yes | Informational |
| `argument-hint` | Yes | Yes | |
| `agent` field | Yes | Yes | Informational — shown in listings |
| `disable-model-invocation` | Yes | No | All skills visible to all agents |
| `user-invocable` | Yes | No | All skills visible |
| `context: fork` | Yes | No | Not supported |
| `model` field | Yes | No | Agent model determined by provider settings |
| `hooks` field | Yes | No | Not supported |
| `/skillname` slash invocation | Yes | No | Agents use `read_skill` tool |
| File watcher | Yes | No | Startup discovery + manual refresh only |
| Nested directory discovery | Yes | No | Single skills directory only |
| Enterprise/managed skills | Yes | No | Single-user app |
| UI creation | No | No | File-based only |
| UI editing | No | Yes | Opens in OS default editor |
| DB storage | No | No | In-memory registry only |
