// ---------------------------------------------------------------------------
// Auto-Earn — escalation / notify-human
//
// The autonomous replacement for request_human_input. When the freelance-expert
// is blocked (ambiguous requirements, missing/invalid credentials, payment/legal/
// call requests, repeated failures), it records a needs-attention item and pushes
// it out three ways: the in-app inbox, a desktop notification, and (opt-in) the
// connected channels. The job is PARKED — never looped.
// ---------------------------------------------------------------------------

import { sqlite } from "../../db/connection";
import { broadcastToWebview } from "../../engine-manager";
import { FREELANCE_EVENTS } from "../events";
import { sendDesktopNotification } from "../../notifications/desktop";
import { getAutoEarnSettings } from "../auto-earn-settings";
import { logJobAction, setJobState } from "./jobs";

export type Severity = "info" | "warn" | "blocker";

export interface EscalateInput {
	jobId?: string;
	platform?: string;
	threadId?: string;
	reason: string;
	detail?: string;
	severity?: Severity;
	/** When true (default for blockers), the job is moved to `parked`. */
	park?: boolean;
}

export interface EscalationDto {
	id: string;
	jobId: string | null;
	platform: string | null;
	threadId: string | null;
	reason: string;
	detail: string | null;
	severity: string;
	status: string;
	createdAt: string;
	resolvedAt: string | null;
}

export async function escalateToHuman(input: EscalateInput): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	const severity = input.severity ?? "warn";
	sqlite
		.prepare(
			`INSERT INTO freelance_escalations (id, job_id, platform, thread_id, reason, detail, severity, status, created_at)
			 VALUES (?,?,?,?,?,?,?, 'open', CURRENT_TIMESTAMP)`,
		)
		.run(id, input.jobId ?? null, input.platform ?? null, input.threadId ?? null, input.reason, input.detail ?? null, severity);

	if (input.jobId) {
		logJobAction(input.jobId, "escalate", `${severity}: ${input.reason}`, severity === "blocker" ? "error" : "info");
		if (input.park ?? severity === "blocker") setJobState(input.jobId, "parked", input.reason);
	}

	const title = `Freelance needs you: ${input.reason}`;
	const body = (input.detail ?? input.reason).slice(0, 400);

	// 1) In-app inbox (needs-attention)
	try {
		const { writeInboxMessage } = await import("../../rpc/inbox");
		await writeInboxMessage({
			sender: "Freelance Auto-Earn",
			content: `⚠️ ${title}\n\n${body}`,
			platform: "freelance",
			threadId: input.threadId,
		});
	} catch (err) {
		console.error("[freelance/notify] inbox write failed:", err);
	}

	// 2) Desktop notification (always — escalations are important)
	try {
		await sendDesktopNotification(title, body);
	} catch {
		/* unavailable */
	}

	// 2b) Unread "needs attention" dot — shows on the sidebar Freelance link + the
	// Auto-Earn tab until the user opens that tab (reuses the project-activity store).
	try {
		const { recordActivity } = await import("../../rpc/activity");
		const { FREELANCE_ATTENTION_PROJECT, FREELANCE_ATTENTION_LOCATION } = await import("../../../shared/freelance/attention");
		await recordActivity(FREELANCE_ATTENTION_PROJECT, FREELANCE_ATTENTION_LOCATION);
	} catch (err) {
		console.error("[freelance/notify] attention activity failed:", err);
	}

	// 3) Connected channels (opt-in)
	try {
		const settings = await getAutoEarnSettings();
		if (settings.notifyChannels) {
			const { broadcastSchedulerResult } = await import("../../channels/manager");
			await broadcastSchedulerResult("Freelance needs attention", `⚠️ ${title}\n${body}`);
		}
	} catch (err) {
		console.error("[freelance/notify] channel broadcast failed:", err);
	}

	broadcastToWebview(FREELANCE_EVENTS.ESCALATION_CREATED, { id, severity, reason: input.reason });
	return { id };
}

export function listEscalations(status: "open" | "resolved" | "all" = "open"): EscalationDto[] {
	const rows =
		status === "all"
			? (sqlite.prepare(`SELECT * FROM freelance_escalations ORDER BY created_at DESC LIMIT 300`).all() as Array<Record<string, unknown>>)
			: (sqlite.prepare(`SELECT * FROM freelance_escalations WHERE status = ? ORDER BY created_at DESC LIMIT 300`).all(status) as Array<Record<string, unknown>>);
	return rows.map((r) => ({
		id: String(r.id),
		jobId: (r.job_id as string | null) ?? null,
		platform: (r.platform as string | null) ?? null,
		threadId: (r.thread_id as string | null) ?? null,
		reason: String(r.reason),
		detail: (r.detail as string | null) ?? null,
		severity: String(r.severity),
		status: String(r.status),
		createdAt: String(r.created_at),
		resolvedAt: (r.resolved_at as string | null) ?? null,
	}));
}

export function resolveEscalation(id: string): void {
	sqlite
		.prepare(`UPDATE freelance_escalations SET status = 'resolved', resolved_at = ? WHERE id = ?`)
		.run(new Date().toISOString(), id);
	broadcastToWebview(FREELANCE_EVENTS.ESCALATION_RESOLVED, { id });
}

/** Resolve every open escalation at once. Returns how many were resolved. */
export function resolveAllEscalations(): number {
	const open = sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_escalations WHERE status = 'open'`).get() as
		| { c: number }
		| undefined;
	const n = open?.c ?? 0;
	if (n === 0) return 0;
	sqlite
		.prepare(`UPDATE freelance_escalations SET status = 'resolved', resolved_at = ? WHERE status = 'open'`)
		.run(new Date().toISOString());
	broadcastToWebview(FREELANCE_EVENTS.ESCALATION_RESOLVED, { id: "*" });
	return n;
}

/**
 * A positive job event the user should know about (e.g. "you won a job!", or
 * "delivered"). Desktop notification gated by the notifyDesktop setting; channels
 * gated by notifyChannels; also dropped into the main app inbox.
 */
export async function notifyJobEvent(title: string, body: string): Promise<void> {
	let settings;
	try {
		settings = await getAutoEarnSettings();
	} catch {
		return;
	}
	try {
		const { writeInboxMessage } = await import("../../rpc/inbox");
		await writeInboxMessage({ sender: "Freelance Auto-Earn", content: `${title}\n\n${body}`, platform: "freelance" });
	} catch {
		/* ignore */
	}
	if (settings.notifyDesktop) {
		try {
			await sendDesktopNotification(title, body);
		} catch {
			/* unavailable */
		}
	}
	if (settings.notifyChannels) {
		try {
			const { broadcastSchedulerResult } = await import("../../channels/manager");
			await broadcastSchedulerResult("Freelance", `${title}\n${body}`);
		} catch {
			/* ignore */
		}
	}
}

export function openEscalationCount(): number {
	const r = sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_escalations WHERE status = 'open'`).get() as
		| { c: number }
		| undefined;
	return r?.c ?? 0;
}
