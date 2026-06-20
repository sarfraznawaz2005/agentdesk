import { sqlite } from "./connection";

// ---------------------------------------------------------------------------
// Pending-approvals persistence (TASK-478, web-app P0 durability)
//
// A thin, write-through mirror of the in-memory plan/approval stores. These
// helpers are intentionally pure DB operations with NO knowledge of broadcasts
// or the engine — the reconcile/re-surface logic lives in engine-manager.ts to
// avoid an import cycle. Every call is wrapped so a missing table or a mid-
// migration DB can never break the agent flow (durability must be best-effort,
// never a new failure mode).
// ---------------------------------------------------------------------------

export type PendingApprovalKind = "shell" | "question" | "plan_tasks";

export interface PendingApprovalRow {
  id: string;
  projectId: string;
  kind: PendingApprovalKind;
  payload: unknown;
  createdAt: string;
  expiresAt: string | null;
}

interface RawRow {
  id: string;
  project_id: string;
  kind: string;
  payload: string;
  created_at: string;
  expires_at: string | null;
}

function decode(r: RawRow): PendingApprovalRow {
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = null;
  }
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as PendingApprovalKind,
    payload,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Insert or replace a pending-approval row. Best-effort; never throws. */
export function savePendingApproval(row: {
  id: string;
  projectId: string;
  kind: PendingApprovalKind;
  payload: unknown;
  expiresAt?: string | null;
}): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO pending_approvals (id, project_id, kind, payload, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           kind       = excluded.kind,
           payload    = excluded.payload,
           expires_at = excluded.expires_at`,
      )
      .run(row.id, row.projectId, row.kind, JSON.stringify(row.payload ?? null), row.expiresAt ?? null);
  } catch (err) {
    console.error("[pending-approvals] save failed:", err);
  }
}

/** Delete a pending-approval row by id. Best-effort; never throws. */
export function deletePendingApproval(id: string): void {
  try {
    sqlite.prepare("DELETE FROM pending_approvals WHERE id = ?").run(id);
  } catch (err) {
    console.error("[pending-approvals] delete failed:", err);
  }
}

/** Load rows for a project, optionally filtered to specific kinds. */
export function loadPendingApprovalsByProject(
  projectId: string,
  kinds?: PendingApprovalKind[],
): PendingApprovalRow[] {
  try {
    const rows = sqlite
      .prepare("SELECT * FROM pending_approvals WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as RawRow[];
    const decoded = rows.map(decode);
    return kinds ? decoded.filter((r) => kinds.includes(r.kind)) : decoded;
  } catch (err) {
    console.error("[pending-approvals] load-by-project failed:", err);
    return [];
  }
}

/** Convenience: the persisted plan task-definitions for a project (or undefined). */
export function loadPlanTaskDefinitions<T = unknown>(projectId: string): T | undefined {
  const rows = loadPendingApprovalsByProject(projectId, ["plan_tasks"]);
  const row = rows.find((r) => r.id === `plan_tasks:${projectId}`) ?? rows[0];
  return row ? (row.payload as T) : undefined;
}

/** All shell/question rows across projects — used for startup reconciliation. */
export function loadStaleInteractiveApprovals(): PendingApprovalRow[] {
  try {
    const rows = sqlite
      .prepare("SELECT * FROM pending_approvals WHERE kind IN ('shell', 'question') ORDER BY created_at ASC")
      .all() as RawRow[];
    return rows.map(decode);
  } catch (err) {
    console.error("[pending-approvals] load-stale failed:", err);
    return [];
  }
}

/** Delete every shell/question row (after startup reconcile has emitted signals). */
export function deleteAllInteractiveApprovals(): void {
  try {
    sqlite.prepare("DELETE FROM pending_approvals WHERE kind IN ('shell', 'question')").run();
  } catch (err) {
    console.error("[pending-approvals] delete-stale failed:", err);
  }
}
