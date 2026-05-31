---
name: skill-creator
description: Create new skills or improve existing ones for AgentDesk agents. Use when the user wants to create a skill from scratch, edit an existing skill, or asks how to write a SKILL.md file.
---

# Skill Creator

Create and improve skills for AgentDesk. Skills are instruction sets that extend agent capabilities — they teach agents how to handle specific tasks like document creation, data processing, or specialized workflows.

## Skill Format

### Directory Structure

```
skill-name/
├── SKILL.md              # Required — frontmatter + instructions
├── scripts/              # Optional — executable code agents can run
├── references/           # Optional — detailed docs loaded on demand
└── assets/               # Optional — templates, images, data files
```

### SKILL.md Format

YAML frontmatter followed by markdown instructions:

```yaml
---
name: my-skill
description: What this skill does and when to use it. Include trigger phrases and contexts.
agent: backend-engineer
allowed-tools: read_file, write_file, run_shell
argument-hint: "[filename] [format]"
---

# Skill instructions here...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase letters, numbers, hyphens only. Max 64 chars. Must match the directory name. No consecutive hyphens (`--`). |
| `description` | Yes | Max 1024 chars. What the skill does AND when to trigger it. This is the primary mechanism agents use to decide whether to load the skill. |
| `agent` | No | Preferred agent to handle this skill (e.g. `backend-engineer`, `frontend_engineer`). PM will delegate to this agent when the skill is invoked. |
| `allowed-tools` | No | Comma or space separated list of tools the skill needs (e.g. `read_file, write_file, run_shell`). |
| `argument-hint` | No | Hint shown in UI for expected arguments (e.g. `[issue-number]`). |

### Variable Substitutions

Use these placeholders in skill content — they get replaced at runtime:

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when skill is invoked |
| `$ARGUMENTS[N]` | Specific argument by 0-based index |
| `$N` | Shorthand for `$ARGUMENTS[N]` (e.g. `$0`, `$1`) |
| `${AGENTDESK_SKILL_DIR}` | Absolute path to the skill's directory |
| `${AGENTDESK_SKILLS_USER_DIR}` | Absolute path to the user skills directory (for creating new skills) |

### Dynamic Context

Use `` !`command` `` syntax to inject shell command output into skill content at load time:

```markdown
Current git branch: !`git branch --show-current`
```

## How to Create a Skill

### 1. Understand Intent

Ask the user:
- What should this skill enable agents to do?
- When should it trigger? (what phrases/contexts)
- What's the expected output?
- Are there dependencies (npm packages, Python libraries, CLI tools)?

### 2. Write the Description

The description is how agents discover the skill. Make it specific and include trigger contexts:

**Bad:** `Helps with PDFs.`

**Good:** `Use this skill whenever the user wants to do anything with PDF files. This includes reading, extracting text/tables, merging, splitting, rotating pages, filling forms, or creating new PDFs. Trigger when the user mentions .pdf files or asks to produce one.`

Tips:
- Describe both **what** the skill does and **when** to use it
- Include specific keywords agents will encounter in user requests
- Be slightly "pushy" — agents tend to under-trigger skills, so be explicit about contexts

### 3. Write Instructions

The markdown body is what the agent sees when the skill is loaded. Write clear, actionable instructions.

**Keep SKILL.md under 500 lines.** Move detailed reference material to separate files.

#### Principles

- **Use imperative form** — "Create the file", not "You should create the file"
- **Explain the why** — agents work better when they understand reasoning, not just rules
- **Include examples** — show expected inputs and outputs
- **Be specific about tools** — name exact libraries, commands, file formats
- **Avoid heavy-handed MUSTs** — explain reasoning instead of shouting

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (~100 tokens) — name + description, always in agent context
2. **SKILL.md body** (<500 lines) — loaded when skill is activated via `read_skill`
3. **Supporting files** (unlimited) — loaded on demand via `read_skill_file`

Reference supporting files from SKILL.md with clear guidance on when to read them:

```markdown
For detailed API reference, see [reference.md](reference.md).
For form-filling workflows, read [forms.md](forms.md).
```

### 4. Bundle Scripts (Optional)

If the skill involves repetitive or deterministic operations, bundle scripts in `scripts/`:

```
my-skill/
├── SKILL.md
└── scripts/
    ├── validate.py
    └── transform.py
```

Reference them in SKILL.md using the `${AGENTDESK_SKILL_DIR}` variable — **never hardcode absolute paths**:

```markdown
After creating the file, validate it:
python ${AGENTDESK_SKILL_DIR}/scripts/validate.py output.docx
```

Hardcoded paths like `C:/Users/.../skills/my-skill/scripts/foo.py` break on other machines.
Always use `${AGENTDESK_SKILL_DIR}` for paths within the skill directory.

**Script guidelines:**
- Make scripts self-contained or document dependencies clearly
- Include helpful error messages
- Handle edge cases gracefully

### Keep Skills Lean

A skill is primarily a **SKILL.md instruction file** — not a full code project. Agents follow the instructions using their existing tools at runtime.

**Do NOT create** these in a skill directory:
- `package.json` — skills are not npm packages, agents don't install dependencies at skill-load time
- `INSTALLATION.md` — the skill is used by agents, not manually installed by humans
- `.gitignore` / `.env.example` — skills are not git repos
- Test files — agents validate their own output as part of the workflow
- README.md — SKILL.md already serves as the documentation

**A typical skill is just:**
```
my-skill/
├── SKILL.md              # Instructions (required, under 500 lines)
├── scripts/              # Only if agents need to run deterministic code
└── references/           # Only if SKILL.md needs to reference detailed docs
```

If you find yourself creating more than 3-4 files, you are over-engineering the skill. Strip it back to the essentials.

### 5. Validate the Skill

After creating all files, call `validate_skill` with the skill directory path. This runs the
same validation as the app's skill registry and catches issues before the user sees them:

```
validate_skill({ skill_dir: "${AGENTDESK_SKILLS_USER_DIR}/my-skill" })
```

Fix any errors reported. Common issues:
- Missing YAML frontmatter (`name`, `description` are required)
- Name doesn't match directory name
- Hardcoded absolute paths (use `${AGENTDESK_SKILL_DIR}` instead)
- SKILL.md over 500 lines

### 6. Test the Skill

After creating the skill:
1. Refresh skills in the UI (Skills page → Refresh button)
2. Verify the card appears without validation errors (red border = errors)
3. Ask the PM to perform a task that should trigger the skill
4. Check the activity feed to confirm the agent loaded the skill via `read_skill`
5. Verify the agent followed the instructions and read any mandatory supporting files

### Naming Conventions

- **Directory name must match `name` field** — `pdf-tools/SKILL.md` needs `name: pdf-tools`
- **Lowercase only** — `my-skill` not `My-Skill`
- **Hyphens for word separation** — `pdf-tools` not `pdf_tools`
- **No consecutive hyphens** — `pdf-tools` not `pdf--tools`
- **No start/end hyphens** — `pdf-tools` not `-pdf-tools-`

## Skills Directory

Skills are stored in two locations:
- **Bundled skills** — ship with the app (read-only)
- **User skills** — in the user data directory (read-write, user can add/edit)

User skills override bundled skills with the same name.

**When creating a new skill, always create it in the user skills directory:**

```
${AGENTDESK_SKILLS_USER_DIR}
```

For example, to create a skill called `daily-news`, create:
```
${AGENTDESK_SKILLS_USER_DIR}/daily-news/SKILL.md
```

Do NOT create skills in the project workspace — they will not be discovered by the app. Always use the path above.

## Example: Minimal Skill

```yaml
---
name: git-conventional
description: Enforce conventional commit messages. Use when the user asks to commit code, create a commit message, or mentions conventional commits.
---

When creating commit messages, use the Conventional Commits format:

type(scope): description

Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
Scope: optional, describes the section of codebase (e.g. auth, api, ui)

Examples:
- feat(auth): add OAuth2 login flow
- fix(api): handle null response from payment gateway
- docs: update README installation steps
```

## Example: Skill with Supporting Files

```yaml
---
name: data-pipeline
description: Build and validate data transformation pipelines. Use when the user needs ETL scripts, data cleaning, CSV/JSON transformations, or database imports.
agent: data-engineer
allowed-tools: read_file, write_file, run_shell
---

# Data Pipeline Builder

## Workflow
1. Analyze the input data format
2. Design the transformation steps
3. Write the pipeline script
4. Validate output with the checker script:
   python ${AGENTDESK_SKILL_DIR}/scripts/validate_output.py output.json

For supported formats and transformation functions, see [reference.md](reference.md).
```
