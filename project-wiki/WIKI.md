# WIKI.md — Project Knowledge Wiki Schema

> This file is the **schema** (the contract). It defines how the wiki is
> structured and maintained. It is the single source of truth for *conventions*;
> the pages are the source of truth for *project knowledge*. Agents: read this
> before writing or editing any wiki page.

This wiki is an **LLM-maintained knowledge base** for the AgentDesk codebase,
following Andrej Karpathy's "LLM Wiki" pattern. It is the connective tissue that
explains **how** the system works and **why** it is built this way — the
semantic layer above the raw code.

The wiki carries both the *structural* "where" (via `reference/directory-map.md`
and per-page `file:line` anchors) and the *semantic* "how/why" — it is the single
knowledge layer for the project.

---

## Three-layer architecture

| Layer | What | Mutability |
|---|---|---|
| **Raw sources** | The code in `src/`, the design docs in `docs/`, git history | Immutable ground truth — the wiki **never** duplicates code, only cites it |
| **The wiki** (`project-wiki/`) | Interlinked markdown: subsystem / flow / decision / gotcha / reference pages, plus `index.md` + `log.md` | LLM-maintained |
| **The schema** (this file + `CLAUDE.md`) | Conventions + the ingest/query/lint procedures | Human-edited |

---

## Directory layout

```
project-wiki/
├── WIKI.md          # this schema
├── index.md         # catalog of every page + 1-line summary, grouped (READ FIRST)
├── log.md           # append-only audit trail
├── overview.md      # the 10,000-ft architecture narrative
├── glossary.md      # project-specific terms
├── subsystems/      # how a subsystem/module actually works (one page per subsystem)
├── flows/           # cross-cutting data/control-flow narratives (with mermaid)
├── decisions/       # ADR-style "why it's this way" (locked decisions & tradeoffs)
├── gotchas/         # traps & non-obvious constraints (high-value, drift-prone)
└── reference/       # lookup tables: tech stack, DB tables, agent roster, directory map, conventions
```

---

## Page conventions

### Filename
`kebab-case.md`, placed in the correct subdirectory by `type`.

### Frontmatter (required on every page)
```yaml
---
title: Human Readable Title
type: subsystem        # subsystem | flow | decision | gotcha | reference | overview | glossary
status: verified       # verified | draft | stale
verified_at: 2026-06-14  # date (or git short SHA) when claims were last checked against code
sources:               # the ground-truth code/doc anchors this page describes
  - src/bun/agents/engine.ts
  - docs/workflow.md
tags: [agents, orchestration]
---
```

### Body rules
1. **Cite, don't copy.** Reference code as `` `src/path/file.ts:line` `` (clickable). Never paste large code blocks — link to the source instead. Short illustrative snippets (≤ ~10 lines) are fine.
2. **Explain how and why.** Don't just restate *where* symbols live (grep does that) — a wiki page must add the flow, the rationale, the tradeoffs, and the gotchas you can't grep.
3. **Cross-link with `[[wikilinks]]`.** Use the target page's filename without extension, e.g. `[[agent-engine]]`. Link liberally; a link to a not-yet-written page is fine — it marks future work.
4. **Anchor to ground truth.** Every non-obvious claim should be traceable to a `file:line` or a `docs/*.md` reference, so a future `lint` pass can verify it.
5. **End every page with two sections:**
   - `## Related` — `[[wikilinks]]` to adjacent pages.
   - `## Open questions` — known unknowns / unverified areas (or "None").

### Page skeleton
```markdown
---
title: ...
type: ...
status: verified
verified_at: ...
sources: [...]
tags: [...]
---

# Title

**One-paragraph what-and-why.** What this subsystem/flow/decision is, and the
single most important thing to understand about it.

## Responsibilities / Key idea
...

## How it works
Narrative of the actual flow, citing `file.ts:line` at each step.

## Key files
| File | Role |
|---|---|
| `src/...` | ... |

## Gotchas / Constraints
...

## Related
- [[other-page]]

## Open questions
- ...
```

---

## The three operations

### Ingest — document or re-document a unit
> "Study subsystem/feature X. Read its code (and any `docs/` design doc). Write or
> update its wiki page following WIKI.md: frontmatter, narrative of how it works
> with `file:line` anchors, key-files table, gotchas, `[[wikilinks]]`. Cross-link
> from related pages. Append an entry to `log.md`."

A single ingest may touch several pages (the subject page + cross-links + index).

### Query — answer from the wiki first
> Read `index.md` → open the relevant page(s) → only drop into raw code if the
> page is missing, thin, or `status: stale`. Promote any valuable freshly-derived
> answer back into a page (and log it).

### Lint — drift control (the maintenance that keeps it alive)
> For each page: confirm `sources:` paths still exist and spot-check `file:line`
> citations still point at what the page claims. Flag mismatches → set
> `status: stale` and fix. Find orphan pages (not in `index.md`), broken
> `[[wikilinks]]`, and contradictions. Code is mutable, so this is the operation
> that matters most for a codebase wiki.

---

## Staying current (how the wiki updates)

A purely deterministic index (one a script extracts from the AST) can be
regenerated by a git hook. This wiki is **semantic prose** — a script cannot
write it. So freshness is a two-part system:

**1. Detection (deterministic — automated).** `scripts/wiki-check.mjs`:
- `bun run wiki:check` — full audit: missing `sources:` paths, **stale** pages
  (a source file committed after the page's `verified_at`), orphan pages, and
  broken `[[wikilinks]]`. Exits non-zero on missing-sources/stale → use in CI.
- `bun run wiki:mark-stale` — same, but sets `status: stale` and logs to `log.md`.
- **Git hook** (`.githooks/pre-commit`, wired via `core.hooksPath`, installed by
  the `prepare` script): on commit, lists the wiki pages whose `sources:` include
  a file you're committing. **Non-blocking** — it nudges, never stops the commit.

**2. Repair (semantic — an agent).** A hook can only *flag* drift; updating the
prose + bumping `verified_at` is the **ingest/lint** job above, done by:
- the agent that made the code change (preferred — it has the context), or
- a periodic pass: `bun run wiki:check` → feed the stale list to an agent (or a
  scheduled/cloud agent) → it updates each flagged page.

> Rule of thumb: **code and its wiki page change in the same commit.** The hook is
> the safety net for when that's forgotten.

---

## Maintenance discipline

- **`index.md`** is the catalog — every page must be listed there with a one-line
  summary, grouped by type. Read it first; update it whenever a page is added.
- **`log.md`** is append-only: `## [YYYY-MM-DD] <op> | <page> | <short SHA>`.
- When code changes in a PR, update the affected page(s) and bump `verified_at`.
- Durable project knowledge from an agent's private memory should **graduate**
  into this committed wiki so it is shared and versioned.
