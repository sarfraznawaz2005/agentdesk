/**
 * Phase 13 — Audit log RPC handlers.
 */
import { sqlite } from "../db/connection";

interface AuditLogEntry {
	id: string;
	action: string;
	entityType: string;
	entityId: string | null;
	details: string | null;
	createdAt: string;
}

/**
 * Retrieve audit log entries with optional filters and pagination.
 */
export function getAuditLog(params: {
	action?: string;
	entityType?: string;
	limit?: number;
	offset?: number;
	before?: string;
	after?: string;
}): { entries: AuditLogEntry[]; total: number } {
	const conditions: string[] = [];
	const values: (string | number)[] = [];

	if (params.action) {
		conditions.push("action = ?");
		values.push(params.action);
	}
	if (params.entityType) {
		conditions.push("entity_type = ?");
		values.push(params.entityType);
	}
	if (params.before) {
		conditions.push("created_at < ?");
		values.push(params.before);
	}
	if (params.after) {
		conditions.push("created_at > ?");
		values.push(params.after);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const countRow = sqlite.prepare(
		`SELECT COUNT(*) as cnt FROM audit_log ${whereClause}`
	).get(...values) as { cnt: number };
	const total = countRow?.cnt ?? 0;

	const limit = params.limit ?? 50;
	const offset = params.offset ?? 0;

	const rows = sqlite.prepare(
		`SELECT id, action, entity_type, entity_id, details, created_at
		 FROM audit_log ${whereClause}
		 ORDER BY created_at DESC
		 LIMIT ? OFFSET ?`
	).all(...(values as (string | number)[]), limit, offset) as Array<{
		id: string;
		action: string;
		entity_type: string;
		entity_id: string | null;
		details: string | null;
		created_at: string;
	}>;

	return {
		entries: rows.map((r) => ({
			id: r.id,
			action: r.action,
			entityType: r.entity_type,
			entityId: r.entity_id,
			details: r.details,
			createdAt: r.created_at,
		})),
		total,
	};
}

/**
 * Clear audit log entries, optionally before a given date.
 */
export function clearAuditLog(params: { before?: string }): { success: boolean; deleted: number } {
	let info;
	if (params.before) {
		info = sqlite.prepare("DELETE FROM audit_log WHERE created_at < ?").run(params.before);
	} else {
		info = sqlite.prepare("DELETE FROM audit_log").run();
	}
	return { success: true, deleted: info.changes };
}
