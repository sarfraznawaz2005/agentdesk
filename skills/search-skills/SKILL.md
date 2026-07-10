---
name: search-skills
description: Discover and install specialized skills from the open agent-skills ecosystem (skills.sh) when a task needs a capability that no existing AgentDesk skill covers. Use when the user asks "is there a skill for X", "find a skill that can do X", "how do I do X" for a specialized/uncommon task, or wants to extend agent capabilities. Requires Node.js (npx) on the user's machine — no API key or account needed. Not to be confused with the internal `find_skills` tool, which only searches skills already installed in AgentDesk.
homepage: https://skills.sh
allowed-tools: run_shell, find_skills, read_skill, read_skill_file, validate_skill
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
6. **No API keys or accounts (hard filter)** — read the skill's description on
   skills.sh and, once fetched, its SKILL.md body for any mention of API keys, tokens,
   OAuth, sign-up, paid/subscription services, or environment variables holding secrets
   (e.g. `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`). If it needs any of those, **exclude it
   from the candidates you present** — don't surface it with a caveat, just move on to
   the next candidate. This is unlike checks 1–5: those are flagged to the user, this one
   is a silent disqualifier. Needing a common local CLI tool/package with no credentials
   involved (node/npm, python/pip, git, pandoc, ffmpeg) does **not** disqualify a skill —
   call that out plainly in Step 5 instead.

Browse https://skills.sh for the leaderboard and skill pages — you need this to see the
audit badges and repo stars, since the bare `npx skills find` output alone doesn't
surface them.

## Step 5 — Present the option

For each candidate that survived Step 4 (including the API-key/account filter), tell the
user:
- The skill name and what it does.
- Install count and source reputation.
- A **clickable markdown link** to the skill's page — `[<skill-name>](<skills.sh page
  URL>)` using the exact URL you browsed in Step 4, falling back to
  `[<owner>/<repo> on GitHub](https://github.com/<owner>/<repo>)` if skills.sh doesn't
  expose a direct page for it. Never paste a bare URL when you have the real page in
  front of you — wrap it as a markdown link so it renders as clickable text the user can
  open in their own browser to read the skill themselves before deciding.
- Any local CLI tool/package the skill needs post-install (e.g. pandoc, a pip package) —
  call this out explicitly so the user knows it isn't fully zero-setup even though it
  passed the credential-free filter.
- The license, if it's anything other than a standard permissive one (see Step 6).

Then ask before installing (installing runs a third-party package via `npx` and writes
files — confirm first, same as any other filesystem-affecting action).

## Step 6 — Install (only after the user agrees)

Use a scratch directory so nothing lands in the user's real project or home directory:

```bash
TMPDIR_SKILLS="$(mktemp -d)"
cd "$TMPDIR_SKILLS" && npx --yes skills add <owner/repo> --skill "<skill-name>" --agent claude-code --copy -y
```

- `--copy` writes real files instead of a symlink (symlinks would point back into the
  temp dir, which gets deleted).
- `--agent claude-code` requests the Claude-Code target, which shares AgentDesk's exact
  SKILL.md format, so the fetched skill needs no translation.
- No `-g` — this stays scoped inside `$TMPDIR_SKILLS`, never touching a real
  `~/.claude/skills/` or the project workspace.

**Don't assume the output path.** Some CLI versions ignore `--agent` and write the skill
under several agent targets at once (you may see the CLI's own log mention Cursor, Codex,
Cline, etc. even though you asked for `claude-code` only) — `$TMPDIR_SKILLS/.claude/skills/<skill-name>/`
is the *expected* location, not a guarantee. Confirm where it actually landed before
touching anything else:

```bash
find "$TMPDIR_SKILLS" -type f -name "SKILL.md" -path "*<skill-name>*"
```

If nothing matches, the install failed — stop here and tell the user, don't proceed to
"present success" later. If one or more matches are found, pick the directory containing
the `.claude/skills/<skill-name>/SKILL.md` path if present (it needs no translation),
otherwise any one match (they're duplicate copies of the same skill for different agent
targets — content is identical). Call that directory `$SRC_SKILL_DIR` for the rest of this
step.

**Check the license before going further.** Look at the fetched SKILL.md's frontmatter
and the skill directory for a license file:

```bash
grep -i "^license" "$SRC_SKILL_DIR/SKILL.md"
ls "$SRC_SKILL_DIR" | grep -i license
```

If it says anything other than a permissive license (MIT, Apache-2.0, BSD, etc.) —
"Proprietary", "Complete terms in LICENSE.txt", no license at all, or you're unsure —
tell the user what it says and get explicit confirmation before copying it in. If a
`LICENSE.txt` or similar file exists, carry it into the copy in the next step so the
terms travel with the skill; don't drop it.

Once the license is clear (or the user confirms), move the result into AgentDesk's user
skills directory and clean up. `cp -r` copies the skill's **entire** directory — SKILL.md
plus every supporting file it depends on (`scripts/`, `references/`, assets, etc.), not
SKILL.md alone — so the install is complete, not partial:

```bash
cp -r "$SRC_SKILL_DIR" "${AGENTDESK_SKILLS_USER_DIR}/<skill-name>"
rm -rf "$TMPDIR_SKILLS"
```

If `find_skills` (internal) already shows a name collision with an existing AgentDesk
skill, ask the user before overwriting rather than silently replacing it.

## Step 7 — Convert to AgentDesk format

The fetched skill targets the generic Claude Code / Agent Skills standard, which supports
a few frontmatter fields AgentDesk's own SKILL.md format doesn't. AgentDesk's supported
frontmatter fields are only: `name`, `description`, `allowed-tools`, `argument-hint`,
`agent`, `hidden`, `feature`. Anything else — most commonly `disable-model-invocation`,
`user-invocable`, `context: fork`, `model`, `hooks` — is not supported and must be
stripped. AgentDesk silently ignores unknown fields, so leaving them in won't break
loading — but they read as broken promises (e.g. a `hooks:` block that will never fire)
and confuse anyone who edits the skill later. Strip them from the copied
`${AGENTDESK_SKILLS_USER_DIR}/<skill-name>/SKILL.md` before validating:

1. Read the frontmatter (`read_file` or `read_skill_file`).
2. If it contains any field outside the supported list above, rewrite the frontmatter
   block via `run_shell` — there is no dedicated file-write tool here, so use
   `sed`/`awk`/a `node -e` one-liner as fits the case. Keep the supported fields
   verbatim; drop everything else. Watch for multi-line blocks (e.g. `hooks:` with
   nested keys) — remove the whole block, not just its first line.
3. Leave the markdown body untouched beyond what license handling in Step 6 required.

## Step 8 — Validate

```
validate_skill({ skill_dir: "${AGENTDESK_SKILLS_USER_DIR}/<skill-name>" })
```

`validate_skill` itself reads the directory and `SKILL.md` off disk — it errors with
"Directory not found" or "SKILL.md not found" if Step 6's copy didn't actually land where
expected. Treat its result as the real source of truth for whether the copy worked, not
the `npx skills add` command's own stdout from Step 6 — that log only describes what the
CLI *attempted*, which can diverge from what ended up on disk (see the path-confirmation
note in Step 6). If it errors, the install did not succeed: go back, re-locate the fetched
skill, and redo the copy — do not move on to Step 9 yet.

Once it returns cleanly, fix anything it flags — most commonly a hardcoded absolute path
left over from the source repo (replace with `${AGENTDESK_SKILL_DIR}`) or a
`name`/directory mismatch — then re-run `validate_skill` to confirm the fix took.

## Step 9 — Verify before reporting success

Never tell the user a skill is installed on the strength of the CLI output or your own
memory of running the copy command — confirm it landed, every time, right before you
report success:

```bash
ls -la "${AGENTDESK_SKILLS_USER_DIR}/<skill-name>/SKILL.md"
```

(or an equivalent `read_file`/`list_directory` call). Only after this returns the real
file — and Step 8's `validate_skill` returned `valid: true` (or you fixed and re-confirmed
whatever it flagged) — tell the user the install succeeded. If either check fails, tell
the user plainly that the install did not complete and what went wrong; do not describe a
partial or failed attempt as done.

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
