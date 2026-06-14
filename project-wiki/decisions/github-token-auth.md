---
title: GitHub Token Auth Without Credential Helper
type: decision
status: verified
verified_at: 2026-06-14
sources:
  - src/bun/rpc/github-api.ts
  - src/bun/rpc/git.ts
  - src/bun/agents/tools/git.ts
  - src/bun/rpc/projects.ts
  - src/bun/issue-fixer/orchestrator.ts
tags: [git, security]
---

# GitHub Token Auth Without Credential Helper

**Every HTTPS git network op against `github.com` (clone / fetch / pull / push /
ls-remote) authenticates with the stored PAT by passing it as an *inline,
per-command* HTTP header while *disabling* Git's credential helper — never by
embedding the token in the remote URL and never by going through the system
credential helper (Git Credential Manager).** The single source of this rule is
`gitAuthArgs(token)` (`src/bun/rpc/github-api.ts:127`), which all callers prefix
onto their `git` argument list.

## The decision in one line

`git -c credential.helper= -c http.https://github.com/.extraheader="AUTHORIZATION: basic <b64>" <op>`
— clear the helper list, inject Basic auth from the token, run the op. See
`gitAuthArgs` at `src/bun/rpc/github-api.ts:127-135`.

## Why not the alternatives

This is a desktop app running git on the **user's own machine**, where the user
also pushes to the same repos manually. That constraint kills the two obvious
approaches:

1. **Embedding the token in the URL** (`https://x-access-token:<token>@github.com/...`).
   When Git Credential Manager is active, an embedded-credential URL makes git
   *store* an `x-access-token` account in the user's OS credential store. That
   pollutes their GCM and then triggers an interactive **"Select an account"**
   GUI prompt on *their own* manual pushes — a bug the app would be silently
   inflicting on the user. This rationale is documented in-code at
   `src/bun/rpc/github-api.ts:204-209` and `:177-181`.

2. **Letting the system credential helper handle it.** During autonomous flows
   (Issue Fixer, auto-commit) there is no human present to answer GCM's
   interactive account-selection dialog, so the op would hang. Clearing
   `credential.helper=` for that one command sidesteps GCM entirely
   (`src/bun/rpc/github-api.ts:119-126`).

The inline-header approach leaves **no stored credential behind**: the header
lives only for the duration of that one `git` invocation, and nothing is written
via `git config` or `git remote set-url`.

## How a network op is wired

```mermaid
flowchart TD
  A[caller: clone/fetch/pull/push] --> B{origin is https://github.com?}
  B -- no --> C[return []  -- SSH uses keys, non-GitHub can't use our token]
  B -- yes --> D[resolveGitHubToken]
  D -- no token --> C
  D -- token --> E[gitAuthArgs token]
  E --> F["runGit([...authArgs, op], cwd)"]
```

- **`githubAuthPrefix`** (`src/bun/rpc/github-api.ts:146-159`) is the convenience
  wrapper for an *existing* repo: it reads `origin`, bails to `[]` unless the URL
  matches `^https://github\.com/` (SSH uses keys and won't prompt; non-GitHub
  remotes can't use our token), resolves the token, and returns
  `gitAuthArgs(token)` or `[]`. It is intentionally a **no-op fallback** so
  wrapping a non-GitHub op changes nothing.
- **`resolveGitHubToken`** (`src/bun/rpc/github-api.ts:94-108`) picks the token in
  a fixed order: per-project custom token (only if the project's token source is
  `"custom"`) → global `github_pat` → legacy `githubToken`/`git` setting. See
  [[backend-core]] for the settings storage.
- **`runGit`** (the canonical `Bun.spawn(["git", …])` wrapper) does **not** add
  auth itself — callers must prefix it. This keeps the auth decision in one place.

## Who calls it

| Call site | Helper used |
|---|---|
| `src/bun/rpc/git.ts:125` (`gitPush`), `:136` (`gitPull`) | `githubAuthPrefix` |
| `src/bun/agents/tools/git.ts:327` (`git_pull`), `:355` (`git_fetch`) | `githubAuthPrefix` |
| `src/bun/rpc/projects.ts:205-206` (clone private repo) | `gitAuthArgs` (URL checked inline first) |
| `src/bun/issue-fixer/orchestrator.ts:216` (fetch/checkout), `:381` (push) | `gitAuthArgs` / `pushBranchAuthenticated` |

## `pushBranchAuthenticated` — the autonomous-push variant

`pushBranchAuthenticated` (`src/bun/rpc/github-api.ts:183-220`) is the hardened
push for flows with no human in the loop (e.g. [[issue-fixer]]). Beyond the
inline-header auth, it adds two safety guarantees:

- It pushes **only the explicitly-named branch** via refspec `branch:branch`
  (`:212`). There is no "default to current branch", so it can't accidentally
  push a checked-out base/working branch. (The Issue Fixer also backstops this
  with its own shell guard + orchestrator checks.)
- All error text is run through `redactToken` (`:161-165`, applied at `:217`) so
  the PAT can never leak into logs or the UI.

It accepts both HTTPS and scp-style SSH origins when *parsing* owner/repo
(`:200`) but always pushes to a reconstructed clean HTTPS URL (`:210`) with the
inline header — never the credential-embedded form.

## Note: the REST client is separate

API calls (`githubFetch`, `validateGithubToken`, `getProjectGithubRepo`) use a
normal `Authorization: Bearer <token>` fetch header
(`src/bun/rpc/github-api.ts:222-248`, `:280-294`). That path has nothing to do
with the credential-helper problem — it never shells out to `git`. The
helper-disabling concern applies **only** to the `git`-subprocess path.

## Key files

| File | Role |
|---|---|
| `src/bun/rpc/github-api.ts` | `gitAuthArgs`, `githubAuthPrefix`, `pushBranchAuthenticated`, `resolveGitHubToken`, `redactToken` — the entire auth strategy |
| `src/bun/rpc/git.ts` | Git RPC handlers (`gitPush`/`gitPull`) that prefix `githubAuthPrefix` |
| `src/bun/agents/tools/git.ts` | Agent `git_pull`/`git_fetch` tools that prefix `githubAuthPrefix` |
| `src/bun/rpc/projects.ts` | Project clone path using `gitAuthArgs` for private GitHub repos |
| `src/bun/issue-fixer/orchestrator.ts` | Autonomous fetch/checkout (`gitAuthArgs`) + push (`pushBranchAuthenticated`) |

## Gotchas / Constraints

- **Always prefix, never embed.** When adding a new git network op, spread
  `gitAuthArgs(token)` / `await githubAuthPrefix(...)` at the **front** of the
  args. Do NOT build an `x-access-token:<token>@github.com` URL and do NOT persist
  the token with `git config` / `git remote set-url` — both reintroduce the GCM
  "Select an account" bug on the user's own pushes (the exact failure this design
  exists to prevent).
- **SSH and non-GitHub remotes are deliberately untouched.** `githubAuthPrefix`
  returns `[]` for them; the op runs exactly as a plain `git` would (SSH keys,
  other remotes' own auth).
- **`runGit` has no built-in auth.** Forgetting the prefix means a private-repo op
  silently falls back to GCM (prompt/hang). There is no compile-time guard — the
  contract is "prefix it yourself".
- **`extraheader` is scoped to `https://github.com/`** only. A repo on
  `github.enterprise.example` would not be matched by `gitAuthArgs`'s header key
  nor by the `^https://github\.com/` URL checks — GHE is out of scope here.

## Related
- [[backend-core]] — `runGit`/`git-runner` and settings storage
- [[issue-fixer]] — primary consumer of `pushBranchAuthenticated`
- [[feature-branch-workflow]] — auto-commit/push that relies on this auth
- [[rpc-layer]] — the `git` RPC handlers

## Open questions
- GitHub Enterprise (`github.*` self-hosted) is unsupported by the URL/header
  matching; no evidence it is intended to work.
