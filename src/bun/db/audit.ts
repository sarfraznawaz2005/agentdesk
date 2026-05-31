/**
 * Phase 13 — Audit log utility.
 *
 * Fire-and-forget function that records an audit event.
 * Uses a prepared statement for performance and never throws
 * so callers don't need error handling.
 */
import { sqlite } from "./connection";

interface AuditEntry {
	action: string;
	entityType: string;
	entityId?: string;
	details?: Record<string, unknown>;
}

// Lazy-initialized prepared statement. Cannot be created at module scope
// because this module may be imported before runMigrations() creates the
// audit_log table.
let insertStmt: ReturnType<typeof sqlite.prepare> | null = null;

function getInsertStmt() {
	if (!insertStmt) {
		insertStmt = sqlite.prepare(`
			INSERT INTO audit_log (id, action, entity_type, entity_id, details, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
	}
	return insertStmt;
}

/**
 * Record an audit event. Never throws — errors are logged to console.
 */
export function logAudit(entry: AuditEntry): void {
	try {
		getInsertStmt().run(
			crypto.randomUUID(),
			entry.action,
			entry.entityType,
			entry.entityId ?? null,
			entry.details ? JSON.stringify(entry.details) : null,
			new Date().toISOString(),
		);
	} catch (err) {
		console.error("[audit] Failed to write audit log:", err);
	}
}
