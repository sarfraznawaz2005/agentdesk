# Wiki Log

Append-only audit trail. Format: `## [YYYY-MM-DD] <op> | <page/scope> | <note>`

## [2026-06-14] bootstrap | whole wiki | Initial multi-agent build (45 pages: 19 backend + 5 frontend subsystems, 6 flows, 5 decisions, 3 gotchas, 5 reference, overview, glossary) authored following WIKI.md. Establishes the project knowledge layer.

## [2026-07-05] ingest | frontend-stores, message-streaming-broadcasts, notifications, rpc-layer, backend-core, plan-approve-execute, frontend-components, frontend-pages, directory-map | Documented (10c1d49+): server-side message queue redesign (`src/bun/message-queue-manager.ts`, drained from `engine-manager.ts`'s idle-check, replacing the old frontend-only queue that discarded messages on project/conversation switch); the shell-approval/`askUserQuestion` cross-project mis-routing fix (per-project `sessionAutoApprovedProjects`, removal of the module-level `activeProjectId` cache, explicit `__projectId`/`__conversationId` arg-stamping); the new plan-approval desktop notification + the `presentPlan`/`planPresented` broadcast-name-mismatch bug it surfaced; and the new `CrossProjectApprovalToast` + `pendingConversationTarget` deep-link mechanism. Added new gotcha page `broadcast-method-name-mismatch.md`.
