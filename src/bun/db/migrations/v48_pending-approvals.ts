import { sqlite } from "../connection";

export const name = "pending-approvals";

// Durability hardening for in-memory plan/approval state (TASK-478, web-app P0).
//
// Three pieces of agent state used to live only in memory and were lost on a
// desktop restart or could not be re-surfaced to a reconnecting web client:
//   • plan task-definitions buffered by the task-planner (planning.ts)
//   • pending shell-approval requests (engine-manager.ts)
//   • pending user-question requests (engine-manager.ts)
//
// This table is a write-through mirror of those stores so a reconnect can
// re-render pending approvals and a restart can either resume (plan tasks) or
// emit a clean "expired — please re-request" signal (shell/question) instead of
// silently dropping the in-flight request.
//
// Raw-SQL table (not Drizzle-managed), consistent with the other feature tables.
export function run(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS pending_approvals (
  id          TEXT PRIMARY KEY,            -- requestId; for plan tasks: 'plan_tasks:<projectId>'
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- 'shell' | 'question' | 'plan_tasks'
  payload     TEXT NOT NULL,               -- JSON blob (the broadcast payload / task definitions)
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT                         -- ISO timestamp; NULL = no timeout (plan_tasks)
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_project
  ON pending_approvals(project_id, kind);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_kind
  ON pending_approvals(kind);
`);
}
