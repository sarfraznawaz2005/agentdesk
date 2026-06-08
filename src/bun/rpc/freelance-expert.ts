// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert RPC (jobs, audit log, escalations, earnings)
// ---------------------------------------------------------------------------

import { sqlite } from "../db/connection";
import { broadcastToWebview } from "../engine-manager";
import { FREELANCE_EVENTS } from "../freelance/events";
import { listEscalations, resolveEscalation as resolveEscalationImpl, type EscalationDto } from "../freelance/expert/notify";
import { listJobs, getJobLog, getJobById, setDeliveryApproved, type FreelanceJob } from "../freelance/expert/jobs";
import { runFreelanceExpert } from "../freelance/expert/orchestrator";

export async function getEscalations(params: { status?: "open" | "resolved" | "all" }): Promise<{ items: EscalationDto[] }> {
	return { items: listEscalations(params.status ?? "open") };
}

export async function resolveEscalation(params: { id: string }): Promise<{ success: boolean }> {
	resolveEscalationImpl(params.id);
	return { success: true };
}

/**
 * Approve a job's delivery: lift the per-job delivery gate, resolve its delivery
 * escalation, and re-run the freelance-expert so it actually delivers now (full-auto
 * only — in assisted the user delivers manually).
 */
export async function approveDelivery(params: { jobId: string }): Promise<{ success: boolean }> {
	const job = getJobById(params.jobId);
	if (!job) return { success: false };
	setDeliveryApproved(params.jobId, true);
	sqlite
		.prepare(`UPDATE freelance_escalations SET status = 'resolved', resolved_at = ? WHERE job_id = ? AND status = 'open' AND reason LIKE 'Ready to deliver%'`)
		.run(new Date().toISOString(), params.jobId);
	broadcastToWebview(FREELANCE_EVENTS.ESCALATION_RESOLVED, { id: params.jobId });
	void runFreelanceExpert({
		platform: job.platform,
		threadId: job.threadId ?? undefined,
		listingId: job.listingId ?? undefined,
		trigger: "manual",
		note: "Delivery approved by the user — proceed with the delivery now.",
	});
	return { success: true };
}

export async function getJobs(params: { state?: string }): Promise<{ jobs: FreelanceJob[] }> {
	return { jobs: listJobs(params.state as FreelanceJob["state"] | undefined) };
}

export async function getJobTimeline(params: { jobId: string }): Promise<{
	entries: Array<{ action: string; detail: string | null; outcome: string; createdAt: string }>;
}> {
	return { entries: getJobLog(params.jobId) };
}

export interface EarningsSummary {
	bidsSent: number;
	jobsWon: number;
	delivered: number;
	openEscalations: number;
	earned: number;
	conversionPct: number;
	avgResponseMinutes: number;
}

export async function getEarningsSummary(): Promise<EarningsSummary> {
	const bidsSent =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_action_log WHERE action = 'submit_bid' AND outcome = 'ok'`).get() as { c: number } | undefined)
			?.c ?? 0;
	const jobsWon =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_jobs WHERE awarded_at IS NOT NULL`).get() as { c: number } | undefined)?.c ?? 0;
	const delivered =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_jobs WHERE state IN ('delivered','complete')`).get() as { c: number } | undefined)?.c ?? 0;
	const openEscalations =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_escalations WHERE status = 'open'`).get() as { c: number } | undefined)?.c ?? 0;
	const earned =
		(sqlite.prepare(`SELECT COALESCE(SUM(earned),0) AS s FROM freelance_jobs`).get() as { s: number } | undefined)?.s ?? 0;

	const conversionPct = bidsSent > 0 ? Math.round((jobsWon / bidsSent) * 100) : 0;

	// Avg minutes from a client (inbound) message to our next reply (outbound) in the
	// same thread. Inbound/outbound derived from from_user vs the account self id.
	const avgGapSec =
		(sqlite
			.prepare(
				`SELECT AVG(gap) AS g FROM (
					SELECT (
						(SELECT MIN(o.sent_at) FROM freelance_inbox_messages o
						 WHERE o.thread_id = m.thread_id
						   AND o.from_user = (SELECT self_user_id FROM freelance_accounts WHERE platform = 'freelancer' LIMIT 1)
						   AND o.sent_at > m.sent_at)
						- m.sent_at) AS gap
					FROM freelance_inbox_messages m
					WHERE m.sent_at IS NOT NULL
					  AND m.from_user IS NOT NULL
					  AND m.from_user != (SELECT self_user_id FROM freelance_accounts WHERE platform = 'freelancer' LIMIT 1)
				) WHERE gap IS NOT NULL AND gap > 0`,
			)
			.get() as { g: number | null } | undefined)?.g ?? null;
	const avgResponseMinutes = avgGapSec ? Math.round(avgGapSec / 60) : 0;

	return { bidsSent, jobsWon, delivered, openEscalations, earned, conversionPct, avgResponseMinutes };
}
