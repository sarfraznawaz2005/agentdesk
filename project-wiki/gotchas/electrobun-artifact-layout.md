---
title: Electrobun Artifact Folder Layout
type: gotcha
status: verified
verified_at: 2026-06-14
sources:
  - .github/workflows/release.yml
  - node_modules/electrobun/src/cli/index.ts
  - electrobun.config.ts
tags: [build, release, electrobun]
---

# Electrobun Artifact Folder Layout

**After `bunx electrobun build --env=stable`, the *final, shippable* deliverables
do NOT live in `build/`.** Electrobun renames them into a project-root `artifacts/`
folder. What is left behind in `build/<channel>-<os>-<arch>/AgentDesk/` is the
**self-extracting installer bundle** — a different artifact with a different
launcher. Shipping the wrong one is exactly what broke the Linux portable build
before v2.0.8. The single most important takeaway: **on Linux, ship
`artifacts/stable-linux-x64-AgentDesk.tar.zst`, never `build/.../AgentDesk/`.**

## Key idea: two app bundles, two destinations

A non-dev Electrobun build produces **two** bundles, not one:

1. **Runtime bundle** — the real app whose `bin/launcher` is the genuine ~92 KB
   static launcher. It is tarred + zstd-compressed
   (`node_modules/electrobun/src/cli/index.ts:3761`, `:3945`) and pushed onto
   `artifactsToUpload` (`:3957`). This is the canonical thing you distribute.
2. **Self-extracting bundle** — rebuilt afterward by
   `createAppBundle(bundleName, buildFolder, ...)`
   (`node_modules/electrobun/src/cli/index.ts:3995`). Its `bin/launcher` is a
   *self-extractor* that unpacks an appended archive at first run. On Windows it
   becomes `AgentDesk-Setup.exe`; on Linux it becomes a self-extracting installer
   archive (`:4171`–`:4187`).

Because `createAppBundle` writes into `buildFolder`
(`build/<platformPrefix>`, computed at
`node_modules/electrobun/src/cli/index.ts:2133`) under the bundle name
(`appFileName`, `:2418`), the self-extracting bundle's folder is literally
`build/stable-linux-x64/AgentDesk/`. The runtime bundle's folder was already
`rmSync`'d right after it was tarred (`:3765`), so the `AgentDesk/` directory you
see lingering in `build/` is **always the self-extractor**, not the runnable app.

## How the move to `artifacts/` works

`artifactFolder` defaults to `"artifacts"`
(`node_modules/electrobun/src/cli/index.ts:1485`; resolved to an absolute path at
`:2144`). After all bundles are produced, Electrobun:

1. wipes and recreates `artifacts/` (`:4193`–`:4198`),
2. writes `<platformPrefix>-update.json` there (`:4214`),
3. and `renameSync`s every entry of `artifactsToUpload` into `artifacts/` with a
   `<channel>-<os>-<arch>-` prefix (`:4222`–`:4236`).

So the runtime tar.zst that started life as
`build/stable-linux-x64/AgentDesk.tar.zst` ends up as
`artifacts/stable-linux-x64-AgentDesk.tar.zst`. **`build/` is scratch space;
`artifacts/` is the output contract.** This is why `release.yml` treats
`artifacts/stable-linux-x64-AgentDesk.tar.zst` as the "source of truth" and hard-
fails if it is missing (`.github/workflows/release.yml:237`–`:243`).

```text
project-root/
├── build/stable-linux-x64/
│   └── AgentDesk/            ← self-extractor bundle (DO NOT ship on Linux)
└── artifacts/
    ├── stable-linux-x64-AgentDesk.tar.zst   ← genuine runtime bundle (ship this)
    └── stable-linux-x64-update.json
```

## The v2.0.8 Linux portable bug + fix

Electrobun's Linux self-extracting installer
(`createLinuxInstallerArchive`, invoked at
`node_modules/electrobun/src/cli/index.ts:4178`) embeds a tar reader that rejects
some archive entries with `TarUnsupportedFileType`, so the self-extractor path is
unreliable on Linux. The fix in `release.yml` deliberately **bypasses the self-
extractor entirely**: it consumes only the runtime bundle from `artifacts/`,
decompresses the zstd, untars it, and re-packs it as a plain `tar.gz`
(`.github/workflows/release.yml:253`–`:266`). Users then `tar -xzf` and run
`./AgentDesk/bin/launcher` directly — no self-extraction step.

Note the Linux job's `metadata.json` for `update.json` is still read out of
`build/` (`.github/workflows/release.yml:248`), since that small file is fine
there; only the *runnable bundle* must come from `artifacts/`.

## Why other platforms don't hit this the same way

Windows and macOS jobs read their deliverables straight out of `build/` because
those platforms' wrapped installers *are* the intended distribution form: the
Windows job repacks `build/stable-win-x64/AgentDesk-Setup.*`
(`.github/workflows/release.yml:86`–`:124`) and the macOS job zips
`build/stable-macos-arm64/AgentDesk.app`
(`.github/workflows/release.yml:157`–`:176`). Linux is the odd one out precisely
because its self-extractor is broken, forcing it to reach into `artifacts/` for
the raw runtime bundle. So the "final output is in `artifacts/` not `build/`" rule
is universal in Electrobun, but AgentDesk only *needs* to honor it on Linux.

## Key files

| File | Role |
|---|---|
| `node_modules/electrobun/src/cli/index.ts:1485` | `artifactFolder: "artifacts"` default |
| `node_modules/electrobun/src/cli/index.ts:3761` | tars the runtime bundle, then deletes it from `build/` (`:3765`) |
| `node_modules/electrobun/src/cli/index.ts:3995` | builds the self-extractor bundle into `build/<env>/AgentDesk/` |
| `node_modules/electrobun/src/cli/index.ts:4222` | renames `artifactsToUpload` into `artifacts/` with platform prefix |
| `.github/workflows/release.yml:237` | Linux job pins `artifacts/stable-linux-x64-AgentDesk.tar.zst` as source of truth |
| `.github/workflows/release.yml:253` | Linux portable fix — unpack runtime bundle, repack as `tar.gz` |
| `electrobun.config.ts` | `build.buildFolder: "build"`, `linux.bundleCEF: true` |

## Gotchas / Constraints

- **Never publish `build/<env>/AgentDesk/` on Linux.** Its launcher only self-
  extracts from an appended archive; it is not a runnable app folder.
- **`artifacts/` is wiped on every build** (`index.ts:4193`). Don't stash anything
  there between builds; copy out what you need within the same job.
- The runtime bundle is **deleted from `build/` immediately after tarring**
  (`index.ts:3765`), so by the time the job finishes, the only `AgentDesk/`
  directory in `build/` is the self-extractor — easy to grab the wrong one.
- Linux ships CEF (`electrobun.config.ts` `linux.bundleCEF: true`), so the runtime
  bundle is large; that is expected, not a packaging error.
- The Windows two-pass build (`release.yml:50`–`:66`) is unrelated to this layout —
  it exists only to embed the icon into `launcher.exe` before the bundle is sealed.

## Related
- [[github-token-auth]]
- [[backend-core]]
- [[playground]]

## Open questions
- Will Electrobun's Linux self-extractor (`createLinuxInstallerArchive`) ever fix
  the `TarUnsupportedFileType` rejection so the portable `tar.gz` workaround can be
  retired? Tracked only by the inline comment at `release.yml:257`–`:259`.
