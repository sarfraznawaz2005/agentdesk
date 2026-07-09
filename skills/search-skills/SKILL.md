---
name: search-skills
description: Discover and install specialized skills from the open agent-skills ecosystem (skills.sh) when a task needs a capability that no existing AgentDesk skill covers. Use when the user asks "is there a skill for X", "find a skill that can do X", "how do I do X" for a specialized/uncommon task, or wants to extend agent capabilities. Requires Node.js (npx) on the user's machine — no API key or account needed. Not to be confused with the internal `find_skills` tool, which only searches skills already installed in AgentDesk.
homepage: https://skills.sh
allowed-tools: run_shell, find_skills, read_skill, validate_skill
---

# Search Skills

Search and install skills from the open agent-skills ecosystem via the `skills` CLI
(`npx skills`), then adapt whatever gets installed into AgentDesk's own skill format
and directory.

## Before searching externally

AgentDesk already ships and lets users install skills in `${AGENTDESK_SKILLS_USER_DIR}`.
Call `find_skills` (the internal tool, not the CLI) first — if an existing AgentDesk
skill already covers the request, use that instead of installing a duplicate from the
web.

## Requirements

- **Node.js installed** (provides `npx`). Check with `command -v npx`. If missing, tell
  the user Node.js is required (https://nodejs.org) and offer to help with the task
  directly instead, or write a custom skill with the `skill-creator` skill.
- **No API key, account, or sign-up.** The CLI reads public skill metadata from GitHub
  and the skills.sh registry over plain network access.
- Installing a skill needs network access to `registry.npmjs.org` (to run `npx skills`),
  `github.com` (to fetch the skill source), and `skills.sh` (metadata/leaderboard).

## Why this needs an extra step for AgentDesk

The `skills` CLI writes installed skills into a target coding agent's own folder (e.g.
`.claude/skills/`, `.cursor/skills/`) — AgentDesk is not one of its built-in targets. So
installing means: let the CLI fetch and validate the skill into a scratch directory using
the Claude-Code target (AgentDesk's skill format is that same open standard), then copy
the resulting folder into `${AGENTDESK_SKILLS_USER_DIR}`. Never install with `-g` (global
scope) — that would write into the user's real `~/.claude/skills/`, which may be a
different tool's actual data. Always use a throwaway temp directory instead.

## Step 1 — Understand what's needed

Identify the domain (e.g. React, PDF, deployment) and the specific task. Only search
externally for a genuinely specialized or uncommon capability — not something a
general-purpose agent already handles well.

## Step 2 — Check well-known sources first

Before running a search, consider whether the need matches a well-known, high-install
repo — these are safe defaults:
- `vercel-labs/agent-skills` — React, Next.js, web/frontend design (100K+ installs)
- `anthropics/skills` — document processing (docx/pdf/pptx/xlsx), frontend design

## Step 3 — Search

```bash
npx --yes skills find "<query>"
npx --yes skills find "<query>" --owner <github-owner>   # scope to a trusted source
```

Try specific queries ("react testing library" beats "testing"), and alternate wording if
the first search comes up empty.

## Step 4 — Verify quality before recommending

**Never recommend a skill from search results alone.** Check:
1. **Install count** — prefer 1K+; be skeptical under 100.
2. **Source reputation** — official orgs (`vercel-labs`, `anthropics`, `microsoft`) rank
   above unknown authors.
3. **GitHub stars** — a source repo with under 100 stars deserves extra scrutiny.
4. **License** — format-compatible does not mean freely reusable. Some official skills
   (e.g. Anthropic's `pdf`, `webapp-testing`, `mcp-builder`) ship a `license:` frontmatter
   field pointing at a `LICENSE.txt` with proprietary/restricted terms, not MIT/Apache.
   Note the license now so you can flag it in Step 5 — don't wait until after installing.
5. **Security audit badges** — each skill's page on https://skills.sh shows Socket, Snyk,
   and Gen Agent Trust Hub audit results. A failing or missing badge on any of the three
   is a real red flag — prefer an alternative candidate with clean audits, or at minimum
   call the failure out explicitly when presenting the option in Step 5. A high install
   count does not excuse a failed audit.

Browse https://skills.sh for the leaderboard and skill pages — you need this to see the
audit badges and repo stars, since the bare `npx skills find` output alone doesn't
surface them.

## Step 5 — Present the option

Tell the user the skill name, what it does, its install count/source, and ask before
installing (installing runs a third-party package via `npx` and writes files — confirm
first, same as any other filesystem-affecting action).

## Step 6 — Install (only after the user agrees)

Use a scratch directory so nothing lands in the user's real project or home directory:

```bash
TMPDIR_SKILLS="$(mktemp -d)"
cd "$TMPDIR_SKILLS" && npx --yes skills add <owner/repo> --skill "<skill-name>" --agent claude-code --copy -y
```

- `--copy` writes real files instead of a symlink (symlinks would point back into the
  temp dir, which gets deleted).
- `--agent claude-code` is a real, well-supported target in the CLI's list and shares
  AgentDesk's exact SKILL.md format, so the fetched skill needs no translation.
- No `-g` — this stays scoped to `$TMPDIR_SKILLS/.claude/skills/<skill-name>/`, never
  touching a real `~/.claude/skills/` or the project workspace.

**Check the license before going further.** Look at the fetched SKILL.md's frontmatter
and the skill directory for a license file:

```bash
grep -i "^license" "$TMPDIR_SKILLS/.claude/skills/<skill-name>/SKILL.md"
ls "$TMPDIR_SKILLS/.claude/skills/<skill-name>/" | grep -i license
```

If it says anything other than a permissive license (MIT, Apache-2.0, BSD, etc.) —
"Proprietary", "Complete terms in LICENSE.txt", no license at all, or you're unsure —
tell the user what it says and get explicit confirmation before copying it in. If a
`LICENSE.txt` or similar file exists, carry it into the copy in the next step so the
terms travel with the skill; don't drop it.

Once the license is clear (or the user confirms), move the result into AgentDesk's user
skills directory and clean up:

```bash
cp -r "$TMPDIR_SKILLS/.claude/skills/<skill-name>" "${AGENTDESK_SKILLS_USER_DIR}/<skill-name>"
rm -rf "$TMPDIR_SKILLS"
```

If `find_skills` (internal) already shows a name collision with an existing AgentDesk
skill, ask the user before overwriting rather than silently replacing it.

## Step 7 — Validate and finish

```
validate_skill({ skill_dir: "${AGENTDESK_SKILLS_USER_DIR}/<skill-name>" })
```

Fix anything it flags — most commonly a hardcoded absolute path left over from the
source repo (replace with `${AGENTDESK_SKILL_DIR}`) or a `name`/directory mismatch.

Skills only load on startup or manual refresh (no file watcher) — tell the user to click
**Refresh** on the Skills page (or restart the app) before the new skill is available to
agents.

If the installed skill's own instructions require extra tooling (e.g. an npm package,
Python library, or CLI like `pandoc`/`ffmpeg`), that's between the user and that skill's
own README — install those separately per its instructions, same as any other skill with
external dependencies (e.g. this app's own `docx` and `live-browser` skills).

## When nothing matches

Acknowledge no existing skill covers it, offer to help with the task directly, and
mention the user can write a custom one with the `skill-creator` skill instead.
