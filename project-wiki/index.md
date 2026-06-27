---
title: Project Wiki Index
type: overview
status: verified
verified_at: 2026-06-14
sources: [project-wiki/WIKI.md]
tags: [index, catalog]
---

# AgentDesk Project Wiki — Index

The catalog of every wiki page. **Read this first**, then open the page you need.
See [[WIKI]] for how this wiki is structured and maintained, and [[overview]]
for the architecture narrative.

> Conventions: pages cite code as `file.ts:line`; cross-links use `[[slug]]`.
> Each page carries `status` + `verified_at` frontmatter so staleness is visible.

---

## Start here
- [[overview]] — AgentDesk architecture from 10,000 ft: the 99% agent-driven model, the Bun/React split, the PM-as-sole-orchestrator, and the plan→approve→execute→review→done lifecycle.
- [[glossary]] — definitions of project-specific terms.
- [[WIKI]] — the wiki schema + ingest/query/lint procedures.

## Subsystems — backend
- [[agent-engine]] — PM streaming, inline sub-agent dispatch, soft approval gate, sequential write-agent guard, auto review cycle; the orchestration core (no separate workflow FSM).
- [[agent-tools]] — tool registration + role-filtering via `getToolsForAgent` (zero `agent_tools` rows ⇒ full registry); per-run binding with workspace/tracking/read-only filtering.
- [[database]] — single SQLite file (WAL + PRAGMAs), Drizzle + raw access, `user_version` migration runner with auto-backup, idempotent seed on launch.
- [[rpc-layer]] — the typed Electrobun RPC boundary: shared contracts → grouped handlers → registration → broadcasts → frontend client; how to add a new RPC end-to-end.
- [[providers]] — provider-agnostic adapter layer; `createProviderAdapter()` maps stored config to an AI SDK model; caching/thinking/context applied one layer up.
- [[channels]] — Discord/WhatsApp/Email adapters + singleton manager routing inbound messages into the engine and relaying replies + task-done broadcasts.
- [[freelance-discovery]] — the discover/filter layer beneath Auto-Earn: RSS poll → workability analysis (keyword/skill/client gates + AI Condition A/B) → shortlist; the enforced status lifecycle and the TOCTOU guard on auto-promotion.
- [[freelance-autoearn]] — opt-in autonomous bid/reply over a real session; passive JSON-tee inbox sync + draft pipelines + Behavior Governor + anomaly breaker.
- [[issue-fixer]] — autonomous GitHub-issue → branch/PR resolution; hidden file-only agent; orchestrator owns git and never merges.
- [[issue-sources]] — multi-source issue integration (GitHub/Jira/Linear/GitLab/Trello/Kanboard) normalised into `external_issues`; sync, buckets, kanban link, auto-close.
- [[remote-sync]] — per-project SFTP/FTP/FTPS sync with AES-256-GCM credentials and a local↔remote SHA manifest.
- [[remote-access]] — web-app remote access: blind Cloudflare relay + outbound desktop session + E2E pairing; the same handler map served over WebSocket. Opt-in, zero-signup.
- [[playground]] — Artifacts-style live-preview builder; reuses `runInlineAgent` with `priorMessages`/`persistToDb:false`/`extraTools`; static server + dev-server persistence.
- [[scheduler-automation]] — croner cron jobs (restart-safe) + event-triggered automation rules through one `executeTask()` sink over an in-process event bus.
- [[plugins]] — in-process plugin framework (manifest + `activate(api)`) contributing tools/prompts/UI; hosts the LSP Manager plugin.
- [[skills]] — filesystem `SKILL.md` skills; dual-dir loading (bundled + user override); on-demand `read_skill` resolution.
- [[lsp]] — lazy, pooled language-server clients over JSON-RPC/stdio for diagnostics/hover/definition/references.
- [[mcp]] — AgentDesk as MCP client: config storage, connection lifecycle, sub-agent-only tool exposure.
- [[notifications]] — OS desktop notifications via ungated + preference-gated paths, backed by `notification_preferences`.
- [[claude-subscription]] — reuse Claude Code's stored OAuth token, impersonate CLI headers, refresh via spawning the CLI on 401, gated by a marker file.
- [[backend-core]] — Bun boot ordering, `EngineManager` per-project cache + global abort/approval registry, shared `lib/` utilities, annotation/preview server.

## Subsystems — frontend
- [[frontend-architecture]] — React 19 SPA in the Electrobun webview: hash-routed TanStack Router under a persistent AppShell; Zustand fed by `agentdesk:*` window events.
- [[frontend-stores]] — Zustand chat & kanban stores; how RPC messages fan out to `window` CustomEvents that drive `setState`.
- [[frontend-pages]] — the flat page tree under a shared AppShell; in-feature nav via local tab state (Project, Settings).
- [[frontend-components]] — navigational map of `src/mainview/components` grouped by folder, over shared `ui/` primitives.
- [[rpc-client]] — the renderer's single entry into Bun: `Electroview.defineRPC`, broadcast→CustomEvent re-emitters, the typed `rpc` wrapper.

## Flows (cross-cutting)
- [[plan-approve-execute]] — task-planner → plan-card approval → deterministic kanban task creation → feature-branch → sequential write-agent dispatch.
- [[kanban-review-cycle]] — backlog→working→review→done enforcement + auto-spawned code-reviewer (`submit_review`, `maxReviewRounds`, `autoCommitTask`).
- [[feature-branch-workflow]] — opt-in AI-named `feature/<slug>` mode stored in settings; `autoCommitTask` switches branch before each commit.
- [[message-streaming-broadcasts]] — engine callbacks → `broadcastToWebview` → `agentdesk:*` DOM events → store token buffering vs per-bubble parts.
- [[context-window-management]] — durable PM-conversation summarization + inline sub-agent 60/70/85/90 compaction ladder; no iteration cap.
- [[auto-earn-end-to-end]] — interceptor → ingest/normalize/correlate → DB → draft → Behavior Governor gate → humanized typing → verified send → action log.

## Decisions (ADR)
- [[pm-sole-orchestrator]] — why there is no WorkflowEngine FSM; transitions split across prompt rules, tool-code guards, and recomputed next-action hints.
- [[inline-agents-vs-sessions]] — why v4 dropped persistent agent sessions for stateless inline sub-agents + handoff summaries.
- [[freelance-own-session]] — why Auto-Earn drives the user's real session and never fingerprint-spoofs (spoofing an owned account is itself a fraud signal).
- [[bid-feasibility-buildability]] — why bid verdicts judge only code-buildability; budget/specs/credentials/deployment are human-handled.
- [[github-token-auth]] — why git auth uses an inline per-command header with the credential helper disabled.

## Gotchas
- [[electrobun-artifact-layout]] — `electrobun build` deliverables land in project-root `artifacts/`, not `build/`; the leftover bundle is the self-extractor (broke Linux portable pre-v2.0.8).
- [[webview2-preview]] — iframe→localhost works; native PDF nav is blocked (use PDF.js route); `Utils.paths.downloads` ignores a relocated Downloads folder.
- [[electrobun-webview-overlay]] — the native `<electrobun-webview>` overlay orphans per-mount; fix is a single app-lifetime singleton rect-synced over a placeholder.

## Reference
- [[directory-map]] — navigable where-is-it map of the whole repo, anchored on the wiring seams. **The authoritative structural index.**
- [[database-tables]] — every SQLite table (Drizzle vs raw-SQL) with purpose, key columns, deprecated/dropped status.
- [[agent-roster]] — every built-in agent (name, display, read-only?, role) + the read-only/PM-visibility/Agents-page-hiding mechanisms.
- [[tech-stack-build-release]] — two-stage Vite+Electrobun build, cross-platform CI release, updater artifact contract, dev commands.
- [[conventions-constraints]] — project invariants: RPC contract boundary, idempotent migrations, prompts-in-seed, kanban enforcement, existing-users compatibility.
